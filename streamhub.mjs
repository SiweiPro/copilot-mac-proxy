import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export class StreamHubError extends Error {
  constructor(code, status = 502) {
    super(code); this.name = 'StreamHubError'; this.code = code; this.status = status;
  }
}

// Only an actually observed StreamHub conversation can configure this adapter.
// Model display names must be mapped by the caller to the tone observed in UI
// and captured traffic; this module never guesses IDs or requests new access.
export function extractCapturedSession(har, expectedTone) {
  for (const entry of har?.log?.entries ?? []) {
    let url; try { url = new URL(entry.request.url); } catch { continue; }
    if (url.protocol !== 'wss:' || url.hostname !== 'substrate.svc.cloud.microsoft'
        || !/^\/m365Copilot\/StreamHub\/[0-9a-f-]+@[0-9a-f-]+$/i.test(url.pathname)
        || url.port || url.username || url.password || !entry._webSocketMessages) continue;
    const sent = entry._webSocketMessages.filter(w => w.type === 'send').flatMap(w =>
      String(w.data).split('\x1e').filter(Boolean).flatMap(raw => {
        try { return [JSON.parse(raw)]; } catch { return []; }
      }));
    const chat = sent.find(o => o.item?.type === 'chat_request'
      && (!expectedTone || o.item.chatStreamRequest?.tone === expectedTone))?.item.chatStreamRequest;
    if (!chat || typeof chat.tone !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(chat.tone)) continue;
    const bearer = url.searchParams.get('access_token');
    let expiresAt;
    try {
      const payload = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString());
      expiresAt = payload.exp * 1000;
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error();
    } catch { throw new StreamHubError('captured_session_expired_or_invalid', 401); }
    const origin = entry.request.headers?.find(h => h.name.toLowerCase() === 'origin')?.value;
    if (origin && origin !== 'https://copilot.cloud.microsoft') {
      throw new StreamHubError('unexpected_captured_origin', 400);
    }
    return {
      // Private transport material. Never serialize this object or log errors
      // from ws; those errors can contain the complete bearer-bearing URL.
      url: url.href, origin, expiresAt, tone: chat.tone,
      protocol: { source: chat.source, optionsSets: chat.optionsSets,
        streamingMode: chat.streamingMode, allowedMessageTypes: chat.allowedMessageTypes,
        clientInfo: chat.clientInfo },
    };
  }
  throw new StreamHubError('verified_model_session_not_found', 400);
}

export function buildRequest(protocol, tone, text) {
  if (typeof text !== 'string' || !text || Buffer.byteLength(text) > 1024 * 1024) {
    throw new StreamHubError('invalid_prompt', 400);
  }
  const conversation = randomUUID(), request = randomUUID(), session = randomUUID();
  const clientInfo = { ...protocol.clientInfo, clientSessionId: session };
  return {
    session, topic: `/conversations/${conversation}`,
    chatRequest: {
      source: protocol.source, optionsSets: protocol.optionsSets,
      streamingMode: protocol.streamingMode, options: {}, extraExtensionParameters: {},
      allowedMessageTypes: protocol.allowedMessageTypes, sliceIds: [], threadLevelGptId: {},
      conversationId: conversation, requestId: request, traceId: randomUUID(),
      isStartOfSession: true, clientInfo,
      message: { author: 'user', inputMethod: 'Keyboard', text, requestId: request,
        locale: 'zh-CN', messageType: 'Chat', adaptiveCards: [],
        clientPreferences: { executionControls: {} }, connectedFederatedConnections: [], clientInfo },
      gpts: [], plugins: [], tone, disconnectBehavior: 'continue',
    },
  };
}

export function parseBotText(frame, previousText = '') {
  if (frame.error || frame.type === 7) throw new StreamHubError('streamhub_rejected_request');
  const item = frame.item;
  if (!item) return { text: previousText, complete: false };
  if (/error/i.test(item.type ?? '') || item.error) throw new StreamHubError('streamhub_service_error');
  let text = previousText, complete = false;
  if (item.type === 'message_part') {
    for (const message of item.argument?.messages ?? []) {
      if (message.author === 'bot' && (!message.messageType || message.messageType === 'Chat')
          && typeof message.text === 'string' && message.text) text = message.text;
      if (message.messageType === 'EndOfRequest') complete = true;
    }
    if (item.target === 'completion') complete = true;
  }
  return { text, complete };
}

class CapturedStreamHubSession {
  #config;
  constructor(config) { this.#config = config; }
  get tone() { return this.#config.tone; }
  get expiresAt() { return this.#config.expiresAt; }
  toJSON() { return { tone: this.tone, expiresAt: this.expiresAt }; }

  async call(text, { signal, timeoutMs = 180000, onText } = {}) {
    if (this.expiresAt <= Date.now()) throw new StreamHubError('captured_session_expired', 401);
    if (signal?.aborted) throw new StreamHubError('client_aborted', 499);
    const { session, topic, chatRequest } = buildRequest(this.#config.protocol, this.tone, text);
    const url = new URL(this.#config.url);
    for (const name of ['chatsessionid', 'XRoutingParameterSessionKey', 'clientrequestid', 'X-SessionId']) {
      if (url.searchParams.has(name)) url.searchParams.set(name, session);
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { origin: this.#config.origin, handshakeTimeout: 15000 });
      let handshaken = false, done = false, reply = '', ping;
      const finish = (error) => {
        if (done) return;
        done = true; clearTimeout(deadline); clearInterval(ping);
        signal?.removeEventListener('abort', abort);
        try { ws.close(); } catch {}
        setTimeout(() => ws.terminate(), 500).unref();
        if (error) reject(error);
        else if (!reply) reject(new StreamHubError('streamhub_empty_response'));
        else resolve({ text: reply, tone: this.tone, usage: null });
      };
      const abort = () => finish(new StreamHubError('client_aborted', 499));
      signal?.addEventListener('abort', abort, { once: true });
      const deadline = setTimeout(() => finish(new StreamHubError('streamhub_timeout', 504)), timeoutMs);
      const send = o => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o) + '\x1e'); };
      ws.on('open', () => send({protocol:'json',version:1}));
      ws.on('unexpected-response', (request, response) => {
        const status = response.statusCode; response.resume();
        finish(new StreamHubError('streamhub_http_rejected', status === 401 || status === 403 ? status : 502));
      });
      ws.on('error', () => finish(new StreamHubError('streamhub_transport_error')));
      ws.on('close', () => finish(new StreamHubError('streamhub_closed_before_completion')));
      ws.on('message', data => {
        for (const raw of data.toString().split('\x1e').filter(Boolean)) {
          if (done) return;
          let frame; try { frame = JSON.parse(raw); } catch { continue; }
          if (!handshaken) {
            if (frame.error) return finish(new StreamHubError('streamhub_handshake_rejected'));
            handshaken = true;
            send({arguments:[],invocationId:'0',streamIds:['1'],target:'stream',type:4});
            send({invocationId:'1',item:{type:'subscribe',topicId:topic,action:'create'},type:2});
            send({invocationId:'1',item:{type:'chat_request',chatStreamRequest:chatRequest,
              idKey:randomUUID(),noteTimestamp:Date.now(),topicId:topic},type:2});
            ping = setInterval(() => send({type:6}),15000);
            continue;
          }
          try {
            const result = parseBotText(frame, reply);
            if (result.text !== reply && typeof onText === 'function') {
              // Snapshot callback, not raw token deltas. ConciseWithPadding
              // can carry adaptive-card patches before a complete bot text.
              onText(result.text);
            }
            reply = result.text;
            if (result.complete) finish();
          } catch (error) { finish(error); }
        }
      });
    });
  }
}

export async function createStreamHubSessionFromHar(file, { expectedTone } = {}) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) {
      throw new StreamHubError('capture_file_must_be_private', 400);
    }
    if (stat.size > 64 * 1024 * 1024) throw new StreamHubError('capture_file_too_large', 400);
    let har;
    try { har = JSON.parse(await handle.readFile('utf8')); }
    catch { throw new StreamHubError('invalid_capture_json', 400); }
    return new CapturedStreamHubSession(extractCapturedSession(har, expectedTone));
  } finally { await handle.close(); }
}

export const sessionFromHar = createStreamHubSessionFromHar;

export async function chat({ session, tone, text, signal, onText, timeoutMs }) {
  if (!(session instanceof CapturedStreamHubSession) || (tone && tone !== session.tone)) {
    throw new StreamHubError('model_not_verified_in_this_capture', 400);
  }
  return session.call(text, { signal, onText, timeoutMs });
}
