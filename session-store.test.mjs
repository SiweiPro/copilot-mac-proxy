import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compactCapture, writeSessionSnapshotFromHar } from './session-store.mjs';
import { sessionFromHar } from './streamhub.mjs';

function capture() {
  const exp = Math.floor(Date.now()/1000)+600;
  const token='test.'+Buffer.from(JSON.stringify({exp})).toString('base64url')+'.not-real';
  return {log:{entries:[{request:{
    url:`wss://substrate.svc.cloud.microsoft/m365Copilot/StreamHub/00000000-0000-0000-0000-000000000001@00000000-0000-0000-0000-000000000002?access_token=${token}&chatsessionid=old-session-secret&extra=unrelated-url-secret`,
    headers:[{name:'Origin',value:'https://copilot.cloud.microsoft'},{name:'Cookie',value:'unrelated-cookie-secret'}],
  },_webSocketMessages:['Claude_Container','Claude_Fable'].map(tone=>({type:'send',data:JSON.stringify({item:{type:'chat_request',chatStreamRequest:{
    tone,source:'officeweb',optionsSets:['safe-option'],streamingMode:'ConciseWithPadding',allowedMessageTypes:['Chat','EndOfRequest'],
    clientInfo:{clientPlatform:'synthetic',clientSessionId:'old-session-secret',userEmail:'unrelated-account-secret'},
    message:{text:'private-chat-secret'},plugins:[{name:'private-plugin-secret'}],gpts:[{id:'private-grounding-secret'}],
  }}})+'\x1e'}))}]}};
}

test('minimal snapshot excludes chat, other headers, old sessions, and arbitrary client fields',()=>{
  const snapshot=compactCapture(capture());
  const output=JSON.stringify(snapshot);
  for(const secret of ['unrelated-url-secret','unrelated-cookie-secret','old-session-secret','unrelated-account-secret','private-chat-secret','private-plugin-secret','private-grounding-secret']) {
    assert.equal(output.includes(secret),false,secret);
  }
  assert.equal(snapshot.log.entries.length,2);
  assert.equal(snapshot._localSessionSnapshot.encrypted,false);
  assert.throws(()=>compactCapture(capture(),['unobserved-model']));
});

test('private atomic snapshot remains compatible with existing model-specific loader',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'streamhub-snapshot-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'capture.har'), dest=path.join(root,'.local/session.json');
  await fs.writeFile(source,JSON.stringify(capture()),{mode:0o600});
  const result=await writeSessionSnapshotFromHar(source,dest);
  assert.deepEqual(result.models.map(m=>m.tone),['Claude_Container','Claude_Fable']);
  assert.equal((await fs.stat(dest)).mode&0o777,0o600);
  assert.equal((await fs.stat(path.dirname(dest))).mode&0o777,0o700);
  const fable=await sessionFromHar(dest,{expectedTone:'Claude_Fable'});
  const opus=await sessionFromHar(dest,{expectedTone:'Claude_Container'});
  assert.equal(fable.tone,'Claude_Fable');
  assert.equal(opus.tone,'Claude_Container');
  assert.equal(JSON.stringify(fable).includes('access_token'),false);
  await writeSessionSnapshotFromHar(source,dest);
  assert.deepEqual((await fs.readdir(path.dirname(dest))),['session.json']);
  await fs.chmod(dest,0o644);
  await assert.rejects(writeSessionSnapshotFromHar(source,dest),{code:'credential_file_must_be_private_and_unlinked'});
});
