import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { compactCapture } from './session-store.mjs';
import { updateSnapshot, handleNativeMessage, reloadGateway, encodeNativeReply, decodeNativeMessage } from './native-host.mjs';

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
