import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { compactCapture } from './session-store.mjs';
import { updateSnapshot, handleNativeMessage, reloadGateway, queryGatewayStatus, encodeNativeReply, decodeNativeMessage } from './native-host.mjs';

const origin = `chrome-extension://${'a'.repeat(32)}/`;
const account = '00000000-0000-0000-0000-000000000001@00000000-0000-0000-0000-000000000002';
const sessionId = '00000000-0000-0000-0000-000000000003';
const key = 'b'.repeat(64);
function token(exp = Math.floor(Date.now()/1000)+600, tag='synthetic') {
  return `test.${Buffer.from(JSON.stringify({exp,tag})).toString('base64url')}.not-real`;
}
function url(bearer = token()) {
  return `wss://substrate.svc.cloud.microsoft/m365Copilot/StreamHub/${account}?access_token=${bearer}&chatsessionid=${sessionId}&licenseType=existing-license&variants=existing-policy`;
}
function message(value = url(token(undefined,'new'))) {
  return {version:1,type:'copilot-streamhub-session',url:value,capturedAt:new Date().toISOString()};
}
function snapshot() {
  return compactCapture({log:{entries:[{request:{url:url(),headers:[{name:'Origin',value:'https://copilot.cloud.microsoft'}]},
    _webSocketMessages:['Claude_Container','Claude_Fable'].map(tone=>({type:'send',data:JSON.stringify({item:{type:'chat_request',chatStreamRequest:{
      tone,source:'officeweb',optionsSets:[],allowedMessageTypes:['Chat'],clientInfo:{clientPlatform:'synthetic'},streamingMode:'ConciseWithPadding',
    }}})+'\x1e'}))}]}});
}

test('only token/session values change; captured policies and verified models stay fixed',()=>{
  const prior=snapshot();
  const input=message(url(token(undefined,'fresh'))+'&newPermission=fake&agent=another');
  input.url=input.url.replace('existing-license','attempted-expansion').replace('existing-policy','attempted-policy');
  const next=updateSnapshot(prior,input);
  for(let i=0;i<2;i++){
    const updated=new URL(next.log.entries[i].request.url);
    assert.equal(updated.searchParams.get('access_token'),new URL(input.url).searchParams.get('access_token'));
    assert.equal(updated.searchParams.get('licenseType'),'existing-license');
    assert.equal(updated.searchParams.get('variants'),'existing-policy');
    assert.equal(updated.searchParams.has('newPermission'),false);
    assert.equal(updated.searchParams.has('agent'),false);
    assert.deepEqual(next.log.entries[i]._webSocketMessages,prior.log.entries[i]._webSocketMessages);
  }
});

test('wrong host, account, token expiry, duplicate token, stale input and new model are rejected',()=>{
  const prior=snapshot();
  assert.throws(()=>updateSnapshot(prior,message(url().replace('substrate.svc.cloud.microsoft','evil.example'))),{code:'invalid_streamhub_url'});
  assert.throws(()=>updateSnapshot(prior,message(url().replace(account,account.replace(/1@/,'9@')))),{code:'account_route_mismatch'});
  assert.throws(()=>updateSnapshot(prior,message(url(token(1)))),{code:'access_token_expired'});
  assert.throws(()=>updateSnapshot(prior,message(url()+'&access_token=extra')),{code:'invalid_access_token'});
  assert.throws(()=>updateSnapshot(prior,{...message(),capturedAt:new Date(1).toISOString()}),{code:'stale_capture'});
  const changed=structuredClone(prior);
  changed.log.entries[0]._webSocketMessages[0].data=changed.log.entries[0]._webSocketMessages[0].data.replace('Claude_Container','NewModel');
  assert.throws(()=>updateSnapshot(changed,message()),{code:'verified_models_required'});
});

test('host checks extension and private snapshot, writes atomically, and reloads with memory key',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-host-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const state=path.join(root,'.local');await fs.mkdir(state,{mode:0o700});
  const configPath=path.join(root,'config.json');
  await fs.writeFile(configPath,JSON.stringify({stateDir:'.local',capture:'.local/session.json',port:19324,extensionId:'a'.repeat(32)}),{mode:0o644});
  const capture=path.join(state,'session.json');
  await fs.writeFile(capture,JSON.stringify(snapshot()),{mode:0o600});
  await fs.writeFile(path.join(state,'gateway-key'),key,{mode:0o600});
  let reloaded=0;
  const reload=async(port,receivedKey)=>{assert.equal(port,19324);assert.equal(receivedKey,key);reloaded++;};
  assert.deepEqual(await handleNativeMessage(message(),{configPath,origin:'chrome-extension://'+'c'.repeat(32)+'/',reload}),{ok:false,code:'untrusted_extension_origin'});
  assert.equal(reloaded,0);
  assert.deepEqual(await handleNativeMessage(message(),{configPath,origin,reload}),{ok:true,code:'session_updated'});
  assert.equal(reloaded,1);
  assert.equal((await fs.stat(capture)).mode&0o777,0o600);
  assert.deepEqual((await fs.readdir(state)).sort(),['gateway-key','session.json']);
  await fs.chmod(capture,0o644);
  assert.deepEqual(await handleNativeMessage(message(),{configPath,origin,reload}),{ok:false,code:'unsafe_local_file'});
  assert.equal(reloaded,1);
});

test('native protocol framing rejects excess data and emits only the fixed reply shape',()=>{
  const value=message(); const bytes=encodeNativeReply(value);
  assert.deepEqual(decodeNativeMessage(bytes),value);
  assert.throws(()=>decodeNativeMessage(Buffer.concat([bytes,Buffer.from('x')])));
  assert.throws(()=>decodeNativeMessage(Buffer.from([255,255,255,255])));
  const reply={ok:false,code:'invalid_message'};
  assert.deepEqual(JSON.parse(encodeNativeReply(reply).subarray(4).toString()),reply);
});

test('reload connects only to loopback and never follows redirects',async t=>{
  let received, redirect=false, calls=0;
  const server=http.createServer((req,res)=>{
    calls++;received={url:req.url,auth:req.headers.authorization,method:req.method};
    if(redirect)res.writeHead(302,{location:'/should-not-be-requested'});else res.writeHead(200);
    res.end('{}');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  await reloadGateway(server.address().port,key);
  assert.deepEqual(received,{url:'/_internal/reload',auth:`Bearer ${key}`,method:'POST'});
  redirect=true;
  await assert.rejects(reloadGateway(server.address().port,key),{code:'gateway_reload_rejected'});
  assert.equal(calls,2);
  await assert.rejects(reloadGateway(0,key),{code:'invalid_local_port'});
});

function health(overrides = {}) {
  return { status: 'ok', bridge: 'copilot-chat-text-tool-envelope', tokenExpiresAt: Date.now() + 600000,
    active: 0, reloadError: null, ...overrides };
}
function unavailable() {
  return { ok: true, code: 'gateway_unavailable', running: false, tokenExpiresAt: null, active: 0, reloadError: true };
}
async function listen(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server;
}

test('status accepts only the exact message and trusted origin without reading credentials or changing files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-status-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, '.local'); await fs.mkdir(stateDir, { mode: 0o700 });
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ stateDir: '.local', capture: '.local/session.json', port: 19324, extensionId: 'a'.repeat(32) }));
  // Neither session.json nor gateway-key exists: status must not require them.
  const input = { version: 1, type: 'copilot-session-status' };
  let probes = 0;
  const expected = { ok: true, code: 'session_status', running: true, tokenExpiresAt: 1, active: 0, reloadError: false };
  const status = async port => { assert.equal(port, 19324); probes++; return expected; };
  const reload = async () => assert.fail('Read-only status must never reload the gateway');
  assert.deepEqual(await handleNativeMessage(input, { configPath, origin, status, reload }), expected);
  assert.equal(probes, 1);
  for (const bad of [{ ...input, url: 'https://unexpected.example/' }, { ...input, version: 2 }]) {
    assert.deepEqual(await handleNativeMessage(bad, { configPath, origin, status, reload }), { ok: false, code: 'invalid_message' });
  }
  assert.deepEqual(await handleNativeMessage(input, { configPath, origin: 'chrome-extension://' + 'c'.repeat(32) + '/', status }),
    { ok: false, code: 'untrusted_extension_origin' });
  assert.equal(probes, 1);
  assert.deepEqual(await fs.readdir(stateDir), []);
  await fs.chmod(stateDir, 0o755);
  assert.deepEqual(await handleNativeMessage(input, { configPath, origin, status }), { ok: false, code: 'unsafe_state_directory' });
  assert.equal(probes, 1);
});

test('status probes only loopback health without credentials and strips all unapproved fields', async t => {
  let received;
  const value = health({ tokenExpiresAt: 1, active: 2, reloadError: 'synthetic secret diagnostic',
    token: 'synthetic-sensitive-value', account: 'synthetic-account', url: url() });
  const server = await listen(t, (req, res) => {
    received = { method: req.method, path: req.url, host: req.headers.host, auth: req.headers.authorization, apiKey: req.headers['x-api-key'] };
    res.end(JSON.stringify(value));
  });
  const port = server.address().port;
  const reply = await queryGatewayStatus(port);
  assert.deepEqual(received, { method: 'GET', path: '/healthz', host: '127.0.0.1:' + port, auth: undefined, apiKey: undefined });
  assert.deepEqual(reply, { ok: true, code: 'session_status', running: true, tokenExpiresAt: 1, active: 2, reloadError: true });
  assert.equal(JSON.stringify(reply).includes('synthetic'), false);
  assert.equal(JSON.stringify(reply).includes('access_token'), false);
});

test('status preserves null and expired credentials and rejects incompatible health shapes', async t => {
  let value = health({ tokenExpiresAt: null });
  const server = await listen(t, (req, res) => res.end(JSON.stringify(value)));
  const port = server.address().port;
  assert.deepEqual(await queryGatewayStatus(port),
    { ok: true, code: 'session_status', running: true, tokenExpiresAt: null, active: 0, reloadError: false });
  for (const change of [{ status: 'different' }, { bridge: 'different' }, { tokenExpiresAt: 'tomorrow' },
    { active: -1 }, { active: 0.5 }, { active: Number.MAX_SAFE_INTEGER + 1 }, { reloadError: { detail: 'secret' } }]) {
    value = health(change);
    await assert.rejects(queryGatewayStatus(port), { code: 'invalid_gateway_status' });
  }
});

test('status rejects oversized and malformed responses and never follows redirects', async t => {
  let mode = 'oversized', calls = 0;
  const server = await listen(t, (req, res) => {
    calls++;
    if (mode === 'redirect') { res.writeHead(302, { location: '/must-not-follow' }); res.end('{}'); }
    else if (mode === 'malformed') res.end('not-json with synthetic secret');
    else res.end(JSON.stringify(health({ extra: 'x'.repeat(16 * 1024) })));
  });
  const port = server.address().port;
  await assert.rejects(queryGatewayStatus(port), { code: 'gateway_status_too_large' });
  mode = 'malformed';
  await assert.rejects(queryGatewayStatus(port), { code: 'invalid_gateway_status' });
  mode = 'redirect';
  await assert.rejects(queryGatewayStatus(port), { code: 'gateway_status_rejected' });
  assert.equal(calls, 3);
});

test('a stopped gateway and a stalled response produce a bounded unavailable status', async t => {
  const stopped = http.createServer();
  stopped.listen(0, '127.0.0.1'); await once(stopped, 'listening');
  const stoppedPort = stopped.address().port;
  await new Promise(resolve => stopped.close(resolve));
  assert.deepEqual(await queryGatewayStatus(stoppedPort), unavailable());
  const stalled = await listen(t, (req, res) => { res.writeHead(200); res.write('{'); });
  const start = Date.now();
  assert.deepEqual(await queryGatewayStatus(stalled.address().port), unavailable());
  assert.ok(Date.now() - start < 6000, 'health probe must have an absolute three-second deadline');
  await assert.rejects(queryGatewayStatus(0), { code: 'invalid_local_port' });
});
