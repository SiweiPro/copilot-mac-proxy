import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { selectSavedAccount } from './extension/account-picker.mjs';

const ACCOUNT = 'v-example@example.test';
const NONCE = '0123456789abcdef0123456789abcdef';
const AUTHORIZE = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?'
  + new URLSearchParams({ client_id: '4765445b-32c6-49b0-83e6-1d93765276ca',
    redirect_uri: 'https://copilot.cloud.microsoft/landingv2', response_type: 'code' });

function node(text = '', overrides = {}) {
  const value = {
    textContent: text, attrs: {}, disabled: false, isConnected: true, hidden: false,
    style: { display: 'block', visibility: 'visible', opacity: '1' }, clicks: 0,
    getAttribute(name) { return this.attrs[name] ?? null; },
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); },
    closest() { return this.hidden ? {} : null; },
    getClientRects() { return this.zeroSize ? [] : [{ width: 120, height: 40 }]; },
    click() { this.clicks++; }, ...overrides,
  };
  Object.defineProperty(value, 'value', { get() { throw new Error('Input values must not be read'); } });
  Object.defineProperty(value, 'innerHTML', { get() { throw new Error('HTML must not be read'); } });
  return value;
}

function page({ buttons = [node(ACCOUNT)], inputs = [], href = AUTHORIZE, active = false,
  focused = false, iframe = false, onYield, authorization = { ok: true }, authorizationThrows = false,
  missingRuntime = false } = {}) {
  const listeners = new Map();
  const eventTarget = (prefix) => ({
    addEventListener(name, fn) { listeners.set(prefix + name, fn); },
    removeEventListener(name, fn) {
      assert.equal(listeners.get(prefix + name), fn);
      listeners.delete(prefix + name);
    },
  });
  const state = { buttons, inputs, yieldCount: 0, authorizationMessages: [] };
  const document = {
    ...eventTarget('document:'), visibilityState: active ? 'visible' : 'hidden',
    hasFocus: () => focused,
    querySelectorAll(selector) {
      if (selector === 'button, [role="button"]') return state.buttons;
      if (selector.startsWith('input:not(')) return state.inputs;
      throw new Error('Unexpected page query');
    },
  };
  for (const name of ['cookie', 'body', 'documentElement', 'forms', 'innerText', 'innerHTML']) {
    Object.defineProperty(document, name, { get() { throw new Error('Broad/private page data must not be read'); } });
  }
  const window = eventTarget('window:');
  window.top = iframe ? {} : window;
  const location = { href };
  const globals = { document, window, location, URL, getComputedStyle: (element) => element.style,
    chrome: { runtime: { sendMessage: async (message) => {
      state.authorizationMessages.push(JSON.parse(JSON.stringify(message)));
      state.yieldCount++;
      await Promise.resolve();
      onYield?.({ state, document, window, location, listeners });
      if (authorizationThrows) throw new Error('Private runtime error');
      return authorization;
    } } },
  };
  if (missingRuntime) delete globals.chrome;
  // Deliberately serialize the function exactly as scripting.executeScript does.
  const context = vm.createContext(globals);
  const injected = vm.runInContext('(' + selectSavedAccount.toString() + ')', context);
  return { state, document, listeners, async run(expected = ACCOUNT, nonce = NONCE) {
    const reply = await injected(expected, nonce);
    assert.deepEqual(Object.keys(reply), ['code']);
    return JSON.parse(JSON.stringify(reply));
  } };
}

test('serialized picker clicks only one exact normalized saved-account button', async () => {
  const account = node('Use ' + ACCOUNT + ' work account', { attrs: { 'aria-label': 'Sign in with ' + ACCOUNT } });
  const other = node('Use other@example.test work account');
  const p = page({ buttons: [other, account] });
  assert.deepEqual(await p.run('  V-EXAMPLE@EXAMPLE.TEST  '), { code: 'selected' });
  assert.equal(account.clicks, 1);
  assert.equal(other.clicks, 0);
  assert.equal(p.state.yieldCount, 1);
  assert.deepEqual(p.state.authorizationMessages, [{ type: 'account-click-authorize', nonce: NONCE }]);
  assert.equal(p.listeners.size, 0);
  assert.deepEqual(await p.run(), { code: 'manual_required' });
  assert.equal(account.clicks, 1);
});

test('account identity is exact and never selected from a partial prefix', async () => {
  for (const label of ['x' + ACCOUNT, ACCOUNT + '.extra', 'v-example+tag@example.test', 'another@example.test']) {
    const button = node(label);
    const p = page({ buttons: [button] });
    assert.deepEqual(await p.run(), { code: 'not_found' });
    assert.equal(button.clicks, 0);
  }
  for (const expected of ['', 'v', ACCOUNT + ' other@example.test', null, 'user@', 'user\n@example.test']) {
    const p = page();
    assert.deepEqual(await p.run(expected), { code: 'manual_required' });
  }
});

test('multiple matching tiles or a tile containing multiple accounts is ambiguous', async () => {
  for (const buttons of [[node(ACCOUNT), node(ACCOUNT)], [node(ACCOUNT + ' another@example.test')]]) {
    const p = page({ buttons });
    assert.deepEqual(await p.run(), { code: 'ambiguous' });
    assert.ok(buttons.every(button => button.clicks === 0));
  }
});

test('only the exact top-level Copilot OAuth request is eligible', async () => {
  const urls = [
    AUTHORIZE.replace('login.microsoftonline.com', 'login.microsoftonline.com.example.test'),
    AUTHORIZE.replace('https:', 'http:'),
    AUTHORIZE.replace('/authorize?', '/token?'),
    AUTHORIZE.replace('4765445b-32c6-49b0-83e6-1d93765276ca', '11111111-1111-1111-1111-111111111111'),
    AUTHORIZE.replace('landingv2', 'other'),
    AUTHORIZE.replace('response_type=code', 'response_type=token'),
    AUTHORIZE + '&client_id=4765445b-32c6-49b0-83e6-1d93765276ca',
    AUTHORIZE + '&redirect_uri=https%3A%2F%2Fcopilot.cloud.microsoft%2Flandingv2',
    AUTHORIZE.replace('/common/', '/consumers/'),
  ];
  for (const href of urls) assert.deepEqual(await page({ href }).run(), { code: 'wrong_origin' });
  assert.deepEqual(await page({ iframe: true }).run(), { code: 'wrong_origin' });
  for (const segment of ['organizations', '11111111-2222-3333-4444-555555555555']) {
    assert.deepEqual(await page({ href: AUTHORIZE.replace('/common/', '/' + segment + '/') }).run(), { code: 'selected' });
  }
});

test('visible or focused pages never receive an automated account click', async () => {
  for (const options of [{ active: true }, { focused: true }]) {
    const p = page(options);
    assert.deepEqual(await p.run(), { code: 'user_active' });
    assert.equal(p.state.buttons[0].clicks, 0);
  }
});

test('password, OTP, editable and consent steps stay manual without reading values', async () => {
  for (const type of ['password', 'text', 'tel', 'number', 'checkbox']) {
    const p = page({ inputs: [node('', { attrs: { type } })] });
    assert.deepEqual(await p.run(), { code: 'manual_required' });
    assert.equal(p.state.buttons[0].clicks, 0);
  }
  for (const label of ['Accept', 'Allow', 'Continue', 'Next', 'Verify', 'Approve', 'Sign in', '同意', '继续', '发送验证码']) {
    const p = page({ buttons: [node(ACCOUNT), node(label)] });
    assert.deepEqual(await p.run(), { code: 'manual_required' });
    assert.equal(p.state.buttons[0].clicks, 0);
  }
  assert.deepEqual(await page({ inputs: [node('', { hidden: true })] }).run(), { code: 'selected' });
});

test('hidden, detached, disabled or zero-size tiles are never clicked', async () => {
  for (const overrides of [
    { hidden: true }, { isConnected: false }, { disabled: true }, { zeroSize: true },
    { attrs: { 'aria-disabled': 'true' } }, { attrs: { disabled: '' } },
    { style: { display: 'none', visibility: 'visible', opacity: '1' } },
    { style: { display: 'block', visibility: 'hidden', opacity: '1' } },
    { style: { display: 'block', visibility: 'visible', opacity: '0' } },
  ]) {
    const button = node(ACCOUNT, overrides);
    assert.deepEqual(await page({ buttons: [button] }).run(), { code: 'not_found' });
    assert.equal(button.clicks, 0);
  }
});

test('account-bearing management and removal actions are not account selection', async () => {
  for (const prefix of ['Remove ', 'Delete ', 'Manage ', 'Sign out ', '移除 ', '注销 ']) {
    const button = node(prefix + ACCOUNT);
    assert.deepEqual(await page({ buttons: [button] }).run(), { code: 'manual_required' });
    assert.equal(button.clicks, 0);
  }
});

test('interaction queued before click permanently revokes the attempt', async () => {
  for (const key of ['document:pointerdown', 'document:keydown', 'document:focusin', 'window:focus']) {
    const p = page({ onYield: ({ listeners }) => listeners.get(key)() });
    assert.deepEqual(await p.run(), { code: 'user_active' });
    assert.equal(p.state.buttons[0].clicks, 0);
    assert.equal(p.listeners.size, 0);
  }
  const p = page({ onYield: ({ document, listeners }) => {
    document.visibilityState = 'visible';
    listeners.get('document:visibilitychange')();
    document.visibilityState = 'hidden';
  } });
  assert.deepEqual(await p.run(), { code: 'user_active' });
  assert.equal(p.state.buttons[0].clicks, 0);
});

test('navigation, a replaced tile or an interactive form before click blocks the attempt', async () => {
  const moved = page({ onYield: ({ location }) => { location.href = AUTHORIZE.replace('landingv2', 'elsewhere'); } });
  assert.deepEqual(await moved.run(), { code: 'wrong_origin' });
  assert.equal(moved.state.buttons[0].clicks, 0);
  const replaced = page({ onYield: ({ state }) => { state.buttons = [node(ACCOUNT)]; } });
  assert.deepEqual(await replaced.run(), { code: 'manual_required' });
  assert.equal(replaced.state.buttons[0].clicks, 0);
  const form = page({ onYield: ({ state }) => { state.inputs = [node('', { attrs: { type: 'password' } })]; } });
  assert.deepEqual(await form.run(), { code: 'manual_required' });
  assert.equal(form.state.buttons[0].clicks, 0);
});

test('missing tiles return immediately and errors do not reveal page or account data', async () => {
  const missing = page({ buttons: [] });
  assert.deepEqual(await missing.run(), { code: 'not_found' });
  assert.equal(missing.state.yieldCount, 0);
  const broken = page({ buttons: [node(ACCOUNT, { click() { throw new Error('private page detail'); } })] });
  assert.deepEqual(await broken.run(), { code: 'manual_required' });
  assert.equal(broken.listeners.size, 0);
});

test('a valid attempt nonce and explicit final worker approval are required', async () => {
  for (const nonce of [null, '', 'abc', 'a'.repeat(31), 'a'.repeat(33), 'G'.repeat(32), 123]) {
    const p = page();
    assert.deepEqual(await p.run(ACCOUNT, nonce), { code: 'manual_required' });
    assert.equal(p.state.authorizationMessages.length, 0);
    assert.equal(p.state.buttons[0].clicks, 0);
  }
  for (const options of [
    { authorization: null }, { authorization: {} }, { authorization: { ok: false } },
    { authorization: { ok: 'true' } }, { authorizationThrows: true }, { missingRuntime: true },
  ]) {
    const p = page(options);
    assert.deepEqual(await p.run(), { code: 'manual_required' });
    assert.equal(p.state.buttons[0].clicks, 0);
    assert.equal(p.listeners.size, 0);
  }
});
