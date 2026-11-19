import http from 'node:http';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionFromHar, chat } from './streamhub.mjs';
import { buildPrompt, toAnthropicMessage } from './envelope.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
// Match the native host: relative paths belong to this installation, not the
// shell's working directory (which may differ when launched by launchd).
config.stateDir = path.resolve(root, config.stateDir);
config.capture = path.resolve(root, config.capture);
const port = config.port ?? 19324;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback port');
await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
await fs.chmod(config.stateDir, 0o700);
const keyPath = path.join(config.stateDir, 'gateway-key');
try { await fs.writeFile(keyPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
catch (e) { if (e.code !== 'EEXIST') throw e; }
const handle = await fs.open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
const stat = await handle.stat();
if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('Private key required');
const key = (await handle.readFile('utf8')).trim(); await handle.close();
if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid local key');
const models = Object.freeze({
  'copilot-claude-opus-5.5': { tone: 'Claude_Container', display_name: 'Copilot Chat · Opus 5.5 (text/tool bridge)' },
  'copilot-claude-fable-5.1': { tone: 'Claude_Fable', display_name: 'Copilot Chat · Fable 5.1 (text/tool bridge)' },
});
let sessions = {}, reloadError = null;
async function reload() {
  const next = {};
  for (const [id, model] of Object.entries(models)) next[id] = await sessionFromHar(config.capture, { expectedTone: model.tone });
  sessions = next; reloadError = null;
}
try { await reload(); } catch (e) { reloadError = e.code || 'capture_unavailable'; }
let active = 0;
const totals = {};
function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function event(res, name, data) { if (!res.destroyed) res.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
function authenticate(req) {
  const credentials = req.rawHeaders.filter((value, index) => index % 2 === 0 && ['authorization', 'x-api-key'].includes(value.toLowerCase())).map(x => x.toLowerCase());
  if (!credentials.length || new Set(credentials).size !== credentials.length) return false;
  const auth = req.headers.authorization;
  const candidate = auth?.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-api-key'];
  if (auth && !auth.startsWith('Bearer ')) return false;
  if (auth && req.headers['x-api-key'] && req.headers['x-api-key'] !== candidate) return false;
  return typeof candidate === 'string' && Buffer.byteLength(candidate) === Buffer.byteLength(key) && timingSafeEqual(Buffer.from(candidate), Buffer.from(key));
}
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw Object.assign(new Error('request_too_large'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}
const server = http.createServer(async (req, res) => {
  let ping, controller, counted = false;
  try {
    if (!["127.0.0.1:" + port, "localhost:" + port].includes(req.headers.host) || req.headers.origin) return send(res, 403, { error: { type: 'permission_error', message: 'Loopback clients only' } });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/healthz' && req.method === 'GET') return send(res, 200, { status: 'ok', bridge: 'copilot-chat-text-tool-envelope', nativeAnthropic: false, tokenExpiresAt: Math.min(...Object.values(sessions).map(s => s.expiresAt)) || null, reloadError, active, totals });
    if (!authenticate(req)) return send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Invalid local gateway key' } });
    if (url.pathname === '/_internal/reload' && req.method === 'POST') { await reload(); return send(res, 200, { status: 'reloaded' }); }
    if (url.pathname === '/v1/models' && req.method === 'GET') return send(res, 200, { data: Object.entries(models).map(([id,m]) => ({ id, type: 'model', display_name: m.display_name, created_at: '2026-11-17T00:00:00Z' })), has_more: false, first_id: 'copilot-claude-opus-5.5', last_id: 'copilot-claude-fable-5.1' });
    if (!['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname) || req.method !== 'POST') return send(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'Unknown route' } });
    const body = await readBody(req);
    if (!body || Array.isArray(body) || typeof body !== 'object') return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'A JSON object is required' } });
    if (!models[body.model]) return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Use copilot-claude-opus-5.5 or copilot-claude-fable-5.1' } });
    const { prompt, tools, toolChoice, stopSequences } = buildPrompt(body);
    if (body.output_config?.format) return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'This text bridge does not implement structured output format.' } });
    if (prompt.length > 200000) return send(res, 413, { type: 'error', error: { type: 'invalid_request_error', message: 'Text bridge prompt exceeds the conservative 200000-character limit; start a smaller session.' } });
    if (url.pathname.endsWith('/count_tokens')) { res.setHeader('x-copilot-token-count', 'estimated'); return send(res, 200, { input_tokens: Math.ceil(Buffer.byteLength(prompt) / 3) }); }
    const session = sessions[body.model];
    if (!session || session.expiresAt <= Date.now()) return send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Copilot session expired or missing. Refresh the Copilot page in Chrome with Local Copilot Session Relay enabled, then retry.' } });
    if (active >= 2) { res.setHeader('retry-after', '10'); return send(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'Local bridge permits two concurrent requests.' } }); }
    active++; counted = true; controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const stream = body.stream === true;
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no', 'x-copilot-bridge': 'buffered-text-tool-envelope', 'x-copilot-usage': 'estimated' }); res.flushHeaders();
      event(res, 'ping', { type: 'ping' }); ping = setInterval(() => event(res, 'ping', { type: 'ping' }), 10000);
    }
    const result = await chat({ session, text: prompt, signal: controller.signal, timeoutMs: 180000 });
    const msg = toAnthropicMessage(result.text, { model: body.model, tools, toolChoice, stopSequences, inputTokens: Math.ceil(Buffer.byteLength(prompt) / 3), outputTokens: Math.ceil(Buffer.byteLength(result.text) / 3) });
    totals[body.model] = (totals[body.model] || 0) + 1;
    if (!stream) { res.setHeader('x-copilot-usage', 'estimated'); return send(res, 200, msg); }
    clearInterval(ping);
    event(res, 'message_start', { type: 'message_start', message: { ...msg, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: msg.usage.input_tokens, output_tokens: 0 } } });
    for (const [index, block] of msg.content.entries()) {
      event(res, 'content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
      event(res, 'content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      event(res, 'content_block_stop', { type: 'content_block_stop', index });
    }
    event(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: msg.stop_reason, stop_sequence: msg.stop_sequence }, usage: { output_tokens: msg.usage.output_tokens } });
    event(res, 'message_stop', { type: 'message_stop' }); res.end();
  } catch (e) {
    const status = e.status || 502;
    const data = { type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 400 ? 'invalid_request_error' : 'api_error', message: e.code || (e.name === 'EnvelopeError' ? e.message : 'Local bridge request failed') } };
    if (!res.headersSent) send(res, status, data); else { event(res, 'error', data); res.end(); }
  } finally { clearInterval(ping); if (counted) active--; }
});
server.requestTimeout = 240000; server.headersTimeout = 15000;
server.listen(port, '127.0.0.1', () => console.log('Copilot Chat compatibility bridge listening on 127.0.0.1:' + port));
server.on('error', () => { console.error('Local bridge listener failed'); process.exitCode = 1; });
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
