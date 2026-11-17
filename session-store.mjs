import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractCapturedSession, StreamHubError } from './streamhub.mjs';

const TONES = ['Claude_Container', 'Claude_Fable'];
const QUERY_KEYS = new Set([
  'access_token', 'disableMemory', 'variants', 'source', 'product', 'agentHost',
  'licenseType', 'isEdu', 'agent', 'scenario',
  'chatsessionid', 'XRoutingParameterSessionKey', 'clientrequestid', 'X-SessionId',
]);
const SESSION_KEYS = ['chatsessionid', 'XRoutingParameterSessionKey', 'clientrequestid', 'X-SessionId'];
const CLIENT_KEYS = [
  'clientPlatform', 'clientAppName', 'clientEntrypoint', 'ProductCategory',
  'clientAppType', 'productEntryPoint', 'deviceOS', 'deviceType', 'clientPlatformVersion',
];

function safeScalar(value, maxLength = 256) {
  return typeof value === 'string' && value.length <= maxLength
    && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
}
function protocolOnly(protocol) {
  const clientInfo = {};
  for (const key of CLIENT_KEYS) {
    const value = safeScalar(protocol.clientInfo?.[key]);
    if (value !== undefined) clientInfo[key] = value;
  }
  return {
    source: safeScalar(protocol.source),
    optionsSets: (protocol.optionsSets ?? []).filter(v => safeScalar(v) !== undefined),
    streamingMode: safeScalar(protocol.streamingMode),
    allowedMessageTypes: (protocol.allowedMessageTypes ?? []).filter(v => safeScalar(v) !== undefined),
    clientInfo,
  };
}

// It remains credential-bearing JSON, NOT encrypted storage. The HAR-shaped
// representation intentionally keeps sessionFromHar compatible while dropping
// all actual request/response history and unrelated service traffic.
export function compactCapture(har, tones = TONES) {
  if (!Array.isArray(tones) || !tones.length || tones.some(t => !TONES.includes(t))) {
    throw new StreamHubError('only_verified_requested_model_tones_are_supported', 400);
  }
  // Prefer newest captured socket and newest matching model request. A normal
  // browser refresh may append a new authenticated socket to an existing HAR.
  const candidates = { log: { entries: [...(har?.log?.entries ?? [])].reverse().map(entry => ({
    ...entry, _webSocketMessages: entry._webSocketMessages
      ? [...entry._webSocketMessages].reverse() : undefined,
  })) } };
  const entries = [...new Set(tones)].map(tone => {
    const config = extractCapturedSession(candidates, tone);
    const url = new URL(config.url);
    for (const key of [...url.searchParams.keys()]) {
      if (!QUERY_KEYS.has(key)) url.searchParams.delete(key);
    }
    // Every actual call replaces these again; the old session IDs are not kept.
    const sessionId = randomUUID();
    for (const key of SESSION_KEYS) {
      if (url.searchParams.has(key)) url.searchParams.set(key, sessionId);
    }
    return {
      request: { url: url.href, headers: config.origin ? [{ name: 'Origin', value: config.origin }] : [] },
      _expiresAt: config.expiresAt,
      _webSocketMessages: [{ type: 'send', data: JSON.stringify({ item: {
        type: 'chat_request', chatStreamRequest: { tone, ...protocolOnly(config.protocol) },
      } }) + '\x1e' }],
    };
  });
  return {
    _localSessionSnapshot: { version: 1, createdAt: new Date().toISOString(), encrypted: false },
    log: { entries },
  };
}

function requirePrivateFile(stat) {
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) {
    throw new StreamHubError('credential_file_must_be_private_and_unlinked', 400);
  }
}

async function readPrivateJson(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); requirePrivateFile(stat);
    if (stat.size > 64 * 1024 * 1024) throw new StreamHubError('capture_file_too_large', 400);
    try { return JSON.parse(await handle.readFile('utf8')); }
    catch { throw new StreamHubError('invalid_capture_json', 400); }
  } finally { await handle.close(); }
}

export async function writeSessionSnapshotFromHar(source, destination, tones = TONES) {
  source = path.resolve(source); destination = path.resolve(destination);
  if (source === destination) throw new StreamHubError('source_and_destination_must_differ', 400);
  const snapshot = compactCapture(await readPrivateJson(source), tones);
  const directory = path.dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const dirStat = await fs.lstat(directory);
  if (!dirStat.isDirectory() || (dirStat.mode & 0o077) !== 0
      || (process.getuid && dirStat.uid !== process.getuid())) {
    throw new StreamHubError('session_directory_must_be_private', 400);
  }
  try { requirePrivateFile(await fs.lstat(destination)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(directory, `.session-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify(snapshot) + '\n');
    await handle.sync(); await handle.close(); handle = undefined;
    await fs.rename(temporary, destination);
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return {
    models: snapshot.log.entries.map(entry => ({
      tone: JSON.parse(entry._webSocketMessages[0].data.replace(/\x1e$/, '')).item.chatStreamRequest.tone,
      expiresAt: entry._expiresAt,
    })),
    encrypted: false,
  };
}

async function main() {
  const [command, source, destination, ...tones] = process.argv.slice(2);
  if (command !== 'import' || !source || !destination) {
    throw new StreamHubError('usage_import_source_har_destination_json_optional_tones', 400);
  }
  const result = await writeSessionSnapshotFromHar(source, destination, tones.length ? tones : TONES);
  console.log(JSON.stringify({
    status: 'saved_minimal_session', encrypted: false,
    models: result.models.map(m => ({ tone: m.tone, expiresAtUTC: new Date(m.expiresAt).toISOString() })),
    reloadRequired: true, automaticRefresh: false,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Never print arbitrary filesystem/network error text or source content.
    console.error(JSON.stringify({status:'session_import_failed',code:error instanceof StreamHubError ? error.code : 'private_file_io_failed'}));
    process.exitCode = 1;
  });
}
