import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseBotText, extractCapturedSession, chat } from './streamhub.mjs';

function capture({ host = 'substrate.svc.cloud.microsoft', exp = Math.floor(Date.now()/1000)+600, tone = 'Claude_Container' } = {}) {
  const token = 'test.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.not-a-real-signature';
  const request = { tone, source: 'synthetic', clientInfo: { clientSessionId:'old-session' },
    optionsSets:[],allowedMessageTypes:['Chat','EndOfRequest'],streamingMode:'ConciseWithPadding',
    gpts:[{id:'private-grounding'}], plugins:[{id:'private-plugin'}] };
  return { log:{entries:[{ request:{ url:`wss://${host}/m365Copilot/StreamHub/00000000-0000-0000-0000-000000000001@00000000-0000-0000-0000-000000000002?access_token=${token}`,
    headers:[{name:'Origin',value:'https://copilot.cloud.microsoft'}]},
    _webSocketMessages:[{type:'send',data:JSON.stringify({item:{type:'chat_request',chatStreamRequest:request}})+'\x1e'}],
  }]}};
}

test('only observed TLS StreamHub host and model are accepted', () => {
  assert.equal(extractCapturedSession(capture(),'Claude_Container').tone,'Claude_Container');
  assert.throws(()=>extractCapturedSession(capture(),'FableNotCaptured'));
  assert.throws(()=>extractCapturedSession(capture({host:'evil.example'})));
  assert.throws(()=>extractCapturedSession(capture({exp:1})),{code:'captured_session_expired_or_invalid'});
});

test('model selection finds the matching later request inside one captured socket', () => {
  const har=capture();
  const later=capture({tone:'Claude_Fable'}).log.entries[0]._webSocketMessages[0];
  har.log.entries[0]._webSocketMessages.push(later);
  assert.equal(extractCapturedSession(har,'Claude_Fable').tone,'Claude_Fable');
  assert.equal(extractCapturedSession(har,'Claude_Container').tone,'Claude_Container');
});

test('each call creates fresh session and removes grounding and plugin sources', () => {
  const config=extractCapturedSession(capture());
  const a=buildRequest(config.protocol,config.tone,'hello');
  const b=buildRequest(config.protocol,config.tone,'hello');
  assert.notEqual(a.session,b.session);
  assert.notEqual(a.topic,b.topic);
  assert.equal(a.chatRequest.isStartOfSession,true);
  assert.deepEqual(a.chatRequest.gpts,[]);
  assert.deepEqual(a.chatRequest.plugins,[]);
  assert.deepEqual(a.chatRequest.message.connectedFederatedConnections,[]);
  assert.deepEqual(a.chatRequest.message.clientPreferences,{executionControls:{}});
  assert.equal(JSON.stringify(a).includes('old-session'),false);
});

test('parser excludes internal and progress text but accepts final plain bot reply', () => {
  const frame={item:{type:'message_part',target:'update',argument:{messages:[
    {author:'bot',messageType:'Internal',text:'private internals'},
    {author:'bot',messageType:'Progress',text:'progress'},
    {author:'user',text:'user echo'},
    {author:'bot',text:'OK'},
    {messageType:'EndOfRequest'},
  ]}}};
  assert.deepEqual(parseBotText(frame),{text:'OK',complete:true});
  assert.throws(()=>parseBotText({type:7,error:'secret-bearing message'}),{code:'streamhub_rejected_request'});
});

test('helper refuses unverified session or model objects', async () => {
  await assert.rejects(chat({session:{tone:'Claude_Container'},tone:'Claude_Container',text:'OK'}),{code:'model_not_verified_in_this_capture'});
});
