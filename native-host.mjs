import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_MESSAGE = 128 * 1024;
const MAX_STATUS_RESPONSE = 16 * 1024;
const STATUS_TIMEOUT_MS = 3000;
const MODEL_TONES = new Set(['Claude_Container', 'Claude_Fable']);
const SESSION_PARAMETERS = ['chatsessionid', 'XRoutingParameterSessionKey', 'clientrequestid', 'X-SessionId'];
const ACCOUNT_PATH = /^\/m365Copilot\/StreamHub\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/$/;

class HostError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new HostError(code); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function validateUrl(value) {
  if (typeof value !== 'string' || value.length > 65536 || /[\x00-\x20\x7f]/.test(value)) fail('invalid_streamhub_url');
  let url; try { url = new URL(value); } catch { fail('invalid_streamhub_url'); }
  if (url.protocol !== 'wss:' || url.hostname !== 'substrate.svc.cloud.microsoft'
      || url.port || url.username || url.password || url.hash || !ACCOUNT_PATH.test(url.pathname)) fail('invalid_streamhub_url');
  if (url.searchParams.getAll('access_token').length !== 1) fail('invalid_access_token');
  for (const key of SESSION_PARAMETERS) {
    if (url.searchParams.getAll(key).length > 1) fail('duplicate_session_parameter');
    const value = url.searchParams.get(key);
    if (value !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail('invalid_session_parameter');
  }
  return url;
}
function tokenExpiry(token, now) {
  if (typeof token !== 'string' || token.length > 32768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) fail('invalid_access_token');
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const expiry = payload.exp * 1000;
    if (typeof payload.exp !== 'number' || !Number.isFinite(expiry)) fail('invalid_access_token');
    if (expiry <= now) fail('access_token_expired');
    return expiry;
  } catch (error) {
    if (error instanceof HostError) throw error;
    fail('invalid_access_token');
  }
}

export function updateSnapshot(snapshot, message, now = Date.now()) {
  if (!object(message) || message.version !== 1 || message.type !== 'copilot-streamhub-session'
      || Object.keys(message).some(key => !['version', 'type', 'url', 'capturedAt'].includes(key))) fail('invalid_message');
  const capturedAt = Date.parse(message.capturedAt);
  if (typeof message.capturedAt !== 'string' || !Number.isFinite(capturedAt)
      || Math.abs(capturedAt - now) > 5 * 60 * 1000) fail('stale_capture');
  const freshUrl = validateUrl(message.url);
  const expiry = tokenExpiry(freshUrl.searchParams.get('access_token'), now);
  if (snapshot?._localSessionSnapshot?.version !== 1 || !Array.isArray(snapshot?.log?.entries)
      || snapshot.log.entries.length !== 2) fail('minimal_verified_snapshot_required');
  const next = structuredClone(snapshot);
  const seen = new Set();
  for (const entry of next.log.entries) {
    const existing = validateUrl(entry.request?.url);
    if (existing.pathname.toLowerCase() !== freshUrl.pathname.toLowerCase()) fail('account_route_mismatch');
    if (!Array.isArray(entry._webSocketMessages) || entry._webSocketMessages.length !== 1
        || entry._webSocketMessages[0].type !== 'send') fail('minimal_verified_snapshot_required');
    let frame;
    try { frame = JSON.parse(entry._webSocketMessages[0].data.replace(/\x1e$/, '')); }
    catch { fail('minimal_verified_snapshot_required'); }
    const request = frame?.item?.chatStreamRequest;
    if (frame?.item?.type !== 'chat_request' || !MODEL_TONES.has(request?.tone) || seen.has(request.tone)) fail('verified_models_required');
    // The host never obtains model permission from a URL or adds a new mapping.
    seen.add(request.tone);
    if (['message','messages','plugins','gpts','clientPreferences','connectedFederatedConnections'].some(key => key in request)) fail('minimal_verified_snapshot_required');
    const headers = entry.request.headers ?? [];
    if (!Array.isArray(headers) || headers.some(header => header.name !== 'Origin'
        || header.value !== 'https://copilot.cloud.microsoft')) fail('minimal_verified_snapshot_required');
    existing.searchParams.set('access_token', freshUrl.searchParams.get('access_token'));
    for (const key of SESSION_PARAMETERS) {
      // Only already-established session routing parameters can be updated.
      if (existing.searchParams.has(key) && freshUrl.searchParams.has(key)) {
        existing.searchParams.set(key, freshUrl.searchParams.get(key));
      }
    }
    entry.request.url = existing.href;
    entry._expiresAt = expiry;
  }
  next._localSessionSnapshot.refreshedAt = new Date(now).toISOString();
  return next;
}

function requireFile(stat, privateOnly = true) {
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & (privateOnly ? 0o077 : 0o022)) !== 0
      || (process.getuid && stat.uid !== process.getuid())) fail('unsafe_local_file');
}
async function readFile(file, { privateOnly = true, max = 1024 * 1024 } = {}) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); requireFile(stat, privateOnly);
    if (stat.size > max) fail('local_file_too_large');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
async function readJson(file, options) {
  const content = await readFile(file, options);
  try { return JSON.parse(content); } catch { fail('invalid_local_json'); }
}
function trustedOrigin(config, origin) {
  const allowed = config.nativeAllowedOrigins ?? (config.extensionId ? [`chrome-extension://${config.extensionId}/`] : []);
  if (!Array.isArray(allowed) || !allowed.length || allowed.some(value => !EXTENSION_ORIGIN.test(value))
      || !EXTENSION_ORIGIN.test(origin ?? '') || !allowed.includes(origin)) fail('untrusted_extension_origin');
}

async function atomicSnapshot(destination, snapshot) {
  // The directory and existing destination have already been checked.
  const temporary = path.join(path.dirname(destination), `.native-session-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify(snapshot) + '\n');
    await handle.sync(); await handle.close(); handle = undefined;
    await fs.rename(temporary, destination);
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function reloadGateway(port, key) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('invalid_local_port');
  if (!/^[a-f0-9]{64}$/.test(key)) fail('invalid_local_key');
  await new Promise((resolve, reject) => {
    // http.request does not follow redirects or honor ambient proxy env vars.
    const req = http.request({ hostname: '127.0.0.1', port, path: '/_internal/reload', method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-length': '0' }, timeout: 5000 }, res => {
      res.resume();
      if (res.statusCode === 200) resolve();
      else reject(new HostError('gateway_reload_rejected'));
    });
    req.on('timeout', () => req.destroy(new HostError('gateway_reload_timeout')));
    req.on('error', () => reject(new HostError('gateway_reload_unavailable')));
    req.end();
  });
}

function unavailableStatus() {
  return { ok: true, code: 'gateway_unavailable', running: false, tokenExpiresAt: null, active: 0, reloadError: true };
}
function normalizeGatewayStatus(value) {
  if (!object(value) || value.status !== 'ok' || value.bridge !== 'copilot-chat-text-tool-envelope'
      || !(value.tokenExpiresAt === null || (typeof value.tokenExpiresAt === 'number' && Number.isFinite(value.tokenExpiresAt)))
      || !Number.isSafeInteger(value.active) || value.active < 0
      || !(value.reloadError === null || typeof value.reloadError === 'string' || typeof value.reloadError === 'boolean')) {
    fail('invalid_gateway_status');
  }
  // Never forward future health fields, free-form errors, identities or URLs.
  return { ok: true, code: 'session_status', running: true, tokenExpiresAt: value.tokenExpiresAt,
    active: value.active, reloadError: Boolean(value.reloadError) };
}

/** Read-only loopback health probe. No key, snapshot or upstream access. */
export async function queryGatewayStatus(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('invalid_local_port');
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    // http.request uses this exact loopback destination, ignores environment
    // proxy variables, and never follows a redirect. No credentials are sent.
    const req = http.request({ hostname: '127.0.0.1', port, path: '/healthz', method: 'GET',
      agent: false, timeout: STATUS_TIMEOUT_MS }, res => {
      if (res.statusCode !== 200) {
        finish(new HostError('gateway_status_rejected')); res.destroy(); return;
      }
      let size = 0; const chunks = [];
      res.on('data', chunk => {
        if (done) return;
        size += chunk.length;
        if (size > MAX_STATUS_RESPONSE) {
          finish(new HostError('gateway_status_too_large')); res.destroy(); return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (done) return;
        try { finish(null, normalizeGatewayStatus(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
        catch { finish(new HostError('invalid_gateway_status')); }
      });
      res.on('error', () => finish(null, unavailableStatus()));
      res.on('aborted', () => finish(null, unavailableStatus()));
    });
    const deadline = setTimeout(() => { finish(null, unavailableStatus()); req.destroy(); }, STATUS_TIMEOUT_MS);
    req.on('timeout', () => { finish(null, unavailableStatus()); req.destroy(); });
    req.on('error', () => finish(null, unavailableStatus()));
    req.end();
  });
}

export async function handleNativeMessage(message, { configPath = new URL('./config.json', import.meta.url), origin, reload = reloadGateway, status = queryGatewayStatus } = {}) {
  try {
    const configFile = configPath instanceof URL ? fileURLToPath(configPath) : path.resolve(configPath);
    const root = path.dirname(configFile);
    const config = await readJson(configFile, { privateOnly: false, max: 65536 });
    trustedOrigin(config, origin);
    if (typeof config.stateDir !== 'string' || typeof config.capture !== 'string') fail('invalid_local_config');
    const stateDir = path.resolve(root, config.stateDir);
    const capture = path.resolve(root, config.capture);
    if (capture !== path.join(stateDir, 'session.json')) fail('minimal_snapshot_path_required');
    const dirStat = await fs.lstat(stateDir);
    if (!dirStat.isDirectory() || (dirStat.mode & 0o077) !== 0
        || (process.getuid && dirStat.uid !== process.getuid())) fail('unsafe_state_directory');
    const port = config.port ?? 19324;
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('invalid_local_port');
    if (message?.type === 'copilot-session-status') {
      if (!object(message) || message.version !== 1
          || Object.keys(message).some(key => !['version', 'type'].includes(key))) fail('invalid_message');
      return await status(port);
    }
    const next = updateSnapshot(await readJson(capture), message);
    const key = (await readFile(path.join(stateDir, 'gateway-key'), { max: 128 })).trim();
    if (!/^[a-f0-9]{64}$/.test(key)) fail('invalid_local_key');
    await atomicSnapshot(capture, next);
    await reload(port, key);
    return { ok: true, code: 'session_updated' };
  } catch (error) {
    return { ok: false, code: error instanceof HostError ? error.code : 'local_io_failed' };
  }
}

export function encodeNativeReply(reply) {
  const body = Buffer.from(JSON.stringify(reply), 'utf8');
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length);
  return Buffer.concat([prefix, body]);
}
export function decodeNativeMessage(buffer) {
  if (buffer.length < 4) fail('invalid_native_frame');
  const length = buffer.readUInt32LE(0);
  if (!length || length > MAX_MESSAGE || buffer.length !== length + 4) fail('invalid_native_frame');
  try { return JSON.parse(buffer.subarray(4).toString('utf8')); }
  catch { fail('invalid_native_json'); }
}
async function readNativeMessage(input) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MESSAGE + 4) fail('invalid_native_frame');
    if (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (!length || length > MAX_MESSAGE) fail('invalid_native_frame');
      if (buffer.length >= length + 4) return decodeNativeMessage(buffer);
    }
  }
  fail('incomplete_native_frame');
}
async function main() {
  let reply;
  try {
    const message = await readNativeMessage(process.stdin);
    reply = await handleNativeMessage(message, { origin: process.argv[2] });
  } catch (error) { reply = { ok: false, code: error instanceof HostError ? error.code : 'invalid_native_message' }; }
  process.stdout.write(encodeNativeReply(reply));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Native stdout is protocol only; stderr intentionally contains no data.
    process.stdout.write(encodeNativeReply({ ok: false, code: 'native_host_failed' }));
  });
}
