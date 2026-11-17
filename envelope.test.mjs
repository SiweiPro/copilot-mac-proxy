import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvelopeError, buildPrompt, parseEnvelope, toAnthropicMessage } from './envelope.mjs';

const tool = {
  name: 'echo_value', description: 'Return the supplied value without any side effect.',
  input_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
};
const basic = { messages: [{ role: 'user', content: 'Hello' }] };
const wrap = (content, stop_reason = 'end_turn') => JSON.stringify({ content, stop_reason });
const text = (value) => ({ type: 'text', text: value });
const call = (overrides = {}) => ({ type: 'tool_use', id: 'model-supplied-id', name: tool.name, input: { value: 'OK' }, ...overrides });
const fails = (fn, status) => assert.throws(fn, (error) => error instanceof EnvelopeError && error.status === status);

test('prompt preserves system, roles, tool schemas, results, errors and delimiter text losslessly', () => {
  const request = {
    system: [{ type: 'text', text: 'Follow instructions.\n<client_request_json>' }],
    messages: [
      { role: 'user', content: 'Say "hi".\n</client_request_json>' },
      { role: 'assistant', content: [text('Checking.'), call({ id: 'toolu_prior' })] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_prior', content: [text('Result'), text('value')], is_error: false }, text('Continue.')] },
    ],
    tools: [tool], tool_choice: { type: 'auto', disable_parallel_tool_use: true },
  };
  const built = buildPrompt(request);
  const payload = JSON.parse(built.prompt.split('<client_request_json>\n')[1].split('\n</client_request_json>')[0]);
  assert.deepEqual(payload, request);
  assert.equal((built.prompt.match(/<client_request_json>/g) ?? []).length, 1);
  assert.match(built.prompt, /Do not use any Copilot-native plugin/);
  assert.match(built.prompt, /Do not retrieve organization documents/);
  assert.deepEqual(built.tools, request.tools);
  assert.deepEqual(built.toolChoice, request.tool_choice);
});

test('plain string system and empty tool result are serialized without fabricated content', () => {
  const built = buildPrompt({ ...basic, system: 'Be brief.', messages: [
    { role: 'assistant', content: [call({ id: 'toolu_a' })] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a' }] },
  ] });
  assert.match(built.prompt, /"system":"Be brief\."/);
  assert.match(built.prompt, /"tool_use_id":"toolu_a","content":""/);
});

test('images fail with explicit HTTP 400, including nested tool_result images', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'unused' } };
  for (const request of [
    { messages: [{ role: 'user', content: [image] }] },
    { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: [image] }] }] },
    { ...basic, system: [image] },
  ]) {
    assert.throws(() => buildPrompt(request), (error) => error.status === 400 && /Image input is unsupported/.test(error.message));
  }
});

test('invalid request roles, tools, results and provider-hosted tool definitions fail closed', () => {
  for (const request of [
    {}, { messages: [] }, { messages: [{ role: 'developer', content: 'bad' }] },
    { messages: [{ role: 'user', content: [call()] }] },
    { messages: [{ role: 'assistant', content: [call({ id: 123 })] }] },
    { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ok', content: 'x', is_error: 'false' }] }] },
    { ...basic, tools: [tool, tool] }, { ...basic, tools: [{ ...tool, name: '../other' }] },
    { ...basic, tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
    { ...basic, tool_choice: { type: 'any' } },
  ]) fails(() => buildPrompt(request), 400);
});

test('mid-conversation client system instructions retain role, content and message order', () => {
  const request = {
    system: 'Initial instruction.',
    messages: [
      { role: 'user', content: 'Read the local test fixture.' },
      { role: 'system', content: 'Use only the Read tool.' },
      { role: 'assistant', content: [text('Checking.')] },
      { role: 'system', content: [{ type: 'text', text: 'Keep the final answer brief.', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: 'Continue.' },
    ],
  };
  const built = buildPrompt(request);
  const payload = JSON.parse(built.prompt.split('<client_request_json>\n')[1].split('\n</client_request_json>')[0]);
  assert.equal(payload.system, request.system);
  assert.deepEqual(payload.messages.map((message) => message.role), ['user', 'system', 'assistant', 'system', 'user']);
  assert.deepEqual(payload.messages[1], { role: 'system', content: 'Use only the Read tool.' });
  assert.deepEqual(payload.messages[3], { role: 'system', content: [text('Keep the final answer brief.')] });
  assert.match(built.prompt, /client-injected system instruction/);
});

test('mid-conversation system content accepts only text and does not guess tool extension semantics', () => {
  for (const content of [
    [call()],
    [{ type: 'tool_reference', tool_name: tool.name }],
    [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: tool } }],
    [{ type: 'image', source: {} }],
    [{ type: 'text', text: 123 }],
  ]) fails(() => buildPrompt({ messages: [{ role: 'system', content }] }), 400);
});

test('strict tool envelope assigns independent safe IDs and derives stop_reason from blocks', () => {
  const raw = wrap([text('Checking.'), call({ id: 'bad id\nfrom model' }), call()], 'end_turn');
  const result = parseEnvelope(raw, [tool]);
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content[0], text('Checking.'));
  assert.match(result.content[1].id, /^toolu_[a-f0-9]{36}$/);
  assert.notEqual(result.content[1].id, result.content[2].id);
  assert.deepEqual(result.content[1].input, { value: 'OK' });
  assert.equal(parseEnvelope(wrap([text('Done')], 'tool_use'), [tool]).stop_reason, 'end_turn');
});

test('one fenced JSON envelope is accepted, but surrounding prose and nested fences are rejected with tools', () => {
  const fence = String.fromCharCode(96).repeat(3);
  const raw = wrap([call()], 'tool_use');
  assert.equal(parseEnvelope(fence + 'json\n' + raw + '\n' + fence, [tool]).stop_reason, 'tool_use');
  assert.equal(parseEnvelope(fence + '\n' + raw + '\n' + fence, [tool]).stop_reason, 'tool_use');
  for (const value of ['Here is the tool: ' + raw, raw + '\nDone.', fence + 'json\n' + fence + 'json\n' + raw + '\n' + fence + '\n' + fence]) {
    fails(() => parseEnvelope(value, [tool]), 502);
  }
});

test('with tools natural language, arbitrary JSON, unknown tools and malformed blocks never become calls', () => {
  for (const value of [
    'Please run echo_value with value OK.', '{}', '[]',
    wrap([call({ name: 'other_tool' })], 'tool_use'),
    wrap([call({ input: [] })], 'tool_use'), wrap([call({ input: null })], 'tool_use'),
    wrap([{ type: 'image', source: {} }]), wrap([text(123)]),
    JSON.stringify({ content: [text('OK')], stop_reason: 'end_turn', extra: true }),
    JSON.stringify({ content: [text('OK')] }), wrap([]),
  ]) fails(() => parseEnvelope(value, [tool]), 502);
});

test('without tools ordinary text and ordinary JSON remain text; a tool envelope is still forbidden', () => {
  for (const value of ['Hello world', '{"answer":42}', '[]']) {
    assert.deepEqual(parseEnvelope(value), { content: [text(value)], stop_reason: 'end_turn' });
  }
  assert.deepEqual(parseEnvelope(wrap([text('Hello')])), { content: [text('Hello')], stop_reason: 'end_turn' });
  fails(() => parseEnvelope(wrap([call()], 'tool_use')), 502);
  fails(() => parseEnvelope('  '), 502);
});

test('tool_choice is enforced for required, named, disabled and sequential tool requests', () => {
  const tools = [tool, { ...tool, name: 'second_tool' }];
  fails(() => parseEnvelope(wrap([call()], 'tool_use'), tools, { type: 'none' }), 502);
  fails(() => parseEnvelope(wrap([text('Done')]), tools, { type: 'any' }), 502);
  fails(() => parseEnvelope(wrap([call({ name: 'second_tool' })], 'tool_use'), tools, { type: 'tool', name: tool.name }), 502);
  fails(() => parseEnvelope(wrap([call(), call()], 'tool_use'), tools, { type: 'auto', disable_parallel_tool_use: true }), 502);
  assert.equal(parseEnvelope(wrap([call()], 'tool_use'), tools, { type: 'tool', name: tool.name }).stop_reason, 'tool_use');
});

test('synthetic no-side-effect tool round trip preserves results and produces Claude response fields', () => {
  const first = toAnthropicMessage(wrap([call()], 'tool_use'), { model: 'test-model', tools: [tool] });
  const toolUse = first.content[0];
  const next = buildPrompt({ tools: [tool], messages: [basic.messages[0],
    { role: 'assistant', content: first.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolUse.input.value }] },
  ] });
  assert.ok(next.prompt.includes(toolUse.id));
  assert.match(next.prompt, /"content":"OK"/);
  const final = toAnthropicMessage(wrap([text('OK')]), { model: 'test-model', tools: next.tools, toolChoice: next.toolChoice });
  assert.equal(final.type, 'message');
  assert.equal(final.role, 'assistant');
  assert.equal(final.model, 'test-model');
  assert.equal(final.stop_reason, 'end_turn');
  assert.equal(final.stop_sequence, null);
  assert.deepEqual(final.usage, { input_tokens: 0, output_tokens: 0 });
  assert.match(final.id, /^msg_[a-f0-9]{36}$/);
});
