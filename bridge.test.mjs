import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Test the real HTTP adapter with synthetic upstream text and no account.
test('HTTP and SSE preserve text stops and reject unsupported contracts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-http-test-'));
  const reserve = net.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  for (const name of ['bridge.mjs', 'envelope.mjs'])
    await fs.copyFile(new URL(name, import.meta.url), path.join(root, name));
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({
    port, stateDir: './.local', capture: './unused.json',
  }));
  const mock = [
    'export async function sessionFromHar() { return { expiresAt: Date.now() + 600000 }; }',
    'export async function chat({ text }) {',
    'const start = text.indexOf("<client_request_json>") + "<client_request_json>".length;',
    'const body = JSON.parse(text.slice(start, text.indexOf("</client_request_json>")));',
    'const value = body.messages.at(-1).content;',
    'if (value === "malformed") return { text: "{" };',
    'return { text: JSON.stringify({ content: [{ type: "text", text: value }], stop_reason: "end_turn" }) };',
    '}',
  ].join('\n');
  await fs.writeFile(path.join(root, 'streamhub.mjs'), mock);
  const child = spawn(process.execPath, [path.join(root, 'bridge.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill('SIGTERM');
    await closed;
    await fs.rm(root, { recursive: true, force: true });
  });
  await Promise.race([
    once(child.stdout, 'data'),
    closed.then(() => { throw new Error('Test bridge exited before listening'); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Test bridge startup timed out')), 5000); timer.unref(); }),
  ]);
  const key = (await fs.readFile(path.join(root, '.local/gateway-key'), 'utf8')).trim();
  const post = (body, route = '/v1/messages') => fetch('http://127.0.0.1:' + port + route, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body),
  });
  const request = (text, extra = {}) => ({
    model: 'copilot-claude-opus-5.5', max_tokens: 100,
    messages: [{ role: 'user', content: text }], stop_sequences: ['</result>'], ...extra,
  });

  const reply = await post(request('<result>first</result>discarded'));
  assert.equal(reply.status, 200);
  const message = await reply.json();
  assert.deepEqual(message.content, [{ type: 'text', text: '<result>first' }]);
  assert.equal(message.stop_reason, 'stop_sequence');
  assert.equal(message.stop_sequence, '</result>');

  const streaming = await post(request('<result>second</result>discarded', { stream: true }));
  assert.equal(streaming.status, 200);
  const events = (await streaming.text()).split('\n\n').flatMap(part => {
    const data = part.split('\n').find(line => line.startsWith('data: '));
    return data ? [JSON.parse(data.slice(6))] : [];
  });
  const start = events.find(e => e.type === 'message_start').message;
  assert.equal(start.stop_reason, null);
  assert.equal(start.stop_sequence, null);
  assert.equal(events.filter(e => e.type === 'content_block_delta').map(e => e.delta.text).join(''), '<result>second');
  assert.deepEqual(events.find(e => e.type === 'message_delta').delta, { stop_reason: 'stop_sequence', stop_sequence: '</result>' });

  const noMatch = await (await post(request('unchanged'))).json();
  assert.equal(noMatch.content[0].text, 'unchanged');
  assert.equal(noMatch.stop_reason, 'end_turn');
  assert.equal(noMatch.stop_sequence, null);
  assert.equal((await post(request('estimate'), '/v1/messages/count_tokens')).status, 200);
  assert.equal((await post(request('malformed'))).status, 502);
  assert.equal((await post(request('invalid stop', { stop_sequences: [''] }))).status, 400);
  assert.equal((await post(request('unsupported format', { output_config: { format: { type: 'json_schema', schema: {} } } }))).status, 400);
  assert.equal((await post(request('unsupported combination', { tools: [{ name: 'example', input_schema: { type: 'object' } }] }))).status, 400);
});
