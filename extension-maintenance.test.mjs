import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  createMaintenance,
  safeHealth,
  isMaintenanceTab,
  MAINTENANCE_URL,
  CHECK_ALARM,
  STATE_KEY,
  OWNER_KEY,
  ACCOUNT_KEY,
  isAccountPickerURL,
} from './extension/maintenance.mjs';

function area() {
  const values = {};
  return {
    values,
    async get(key) {
      return { [key]: structuredClone(values[key]) };
    },
    async set(value) {
      Object.assign(values, structuredClone(value));
    },
    async remove(key) {
      delete values[key];
    },
  };
}
function fixture(selectAccount) {
  let time = 1800000000000,
    nextId = 100;
  const local = area(),
    session = area(),
    tabs = new Map(),
    alarms = new Map(),
    created = [],
    removed = [];
  const initialHealth = {
    ok: true,
    code: 'session_status',
    running: true,
    tokenExpiresAt: time + 3600000,
    active: 0,
    reloadError: false,
  };
  let reply = initialHealth;
  const api = {
    storage: { local, session },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    tabs: {
      async get(id) {
        if (!tabs.has(id)) throw new Error('missing');
        return structuredClone(tabs.get(id));
      },
      async create(options) {
        created.push(options);
        const tab = { id: nextId++, windowId: 1, active: options.active, incognito: false, url: options.url, status: 'complete' };
        tabs.set(tab.id, tab);
        return structuredClone(tab);
      },
      async remove(id) {
        removed.push(id);
        tabs.delete(id);
      },
    },
    alarms: {
      async create(name, options) {
        alarms.set(name, options);
      },
      async clear(name) {
        alarms.delete(name);
      },
    },
  };
  const options = { now: () => time, statusRequest: async () => structuredClone(reply), selectAccount };
  let controller = createMaintenance(api, options);
  return {
    api,
    local,
    session,
    tabs,
    alarms,
    created,
    removed,
    get controller() {
      return controller;
    },
    get time() {
      return time;
    },
    advance(ms) {
      time += ms;
    },
    health(value) {
      reply = { ...initialHealth, ...value };
    },
    state() {
      return structuredClone(local.values[STATE_KEY]);
    },
    owner() {
      return structuredClone(session.values[OWNER_KEY]);
    },
    restartWorker() {
      controller = createMaintenance(api, options);
    },
    restartBrowser() {
      delete session.values[OWNER_KEY];
      controller = createMaintenance(api, options);
    },
  };
}

test('maintenance defaults off and preserves passive relay operation without creating tabs', async () => {
  const f = fixture();
  f.health({ tokenExpiresAt: 1 });
  await f.controller.initialize();
  assert.equal(f.state().enabled, false);
  assert.equal(f.state().status, 'disabled');
  assert.equal(f.created.length, 0);
  await f.controller.relayAccepted(55);
  assert.equal(f.created.length, 0);
  assert.equal(f.alarms.has(CHECK_ALARM), false);
});
test('enabled scheduler checks every five minutes and skips healthy, busy, stopped, or invalid status', async () => {
  const f = fixture();
  await f.controller.setEnabled(true);
  assert.deepEqual(f.alarms.get(CHECK_ALARM), { periodInMinutes: 5 });
  assert.equal(f.created.length, 0);
  f.health({ tokenExpiresAt: 1, active: 1 });
  await f.controller.alarm(CHECK_ALARM);
  assert.equal(f.state().status, 'busy');
  f.health({ code: 'gateway_unavailable', running: false, tokenExpiresAt: null, reloadError: true });
  await f.controller.alarm(CHECK_ALARM);
  assert.equal(f.state().status, 'waiting_for_gateway');
  f.health({ tokenExpiresAt: 1, active: -1 });
  await f.controller.alarm(CHECK_ALARM);
  assert.equal(f.state().status, 'gateway_error');
  assert.equal(f.created.length, 0);
});
test('near expiry creates only a tagged background page, with persistent rate limit and deadline', async () => {
  const f = fixture();
  f.health({ tokenExpiresAt: f.time + 600000 });
  await f.controller.setEnabled(true);
  assert.deepEqual(f.created, [{ url: MAINTENANCE_URL, active: false }]);
  const owner = f.owner();
  assert.deepEqual(f.alarms.get(owner.deadlineName), { when: f.time + 120000 });
  await Promise.all([f.controller.check(), f.controller.check(), f.controller.alarm(CHECK_ALARM)]);
  assert.equal(f.created.length, 1);
  assert.equal(f.state().lastAttemptAt, f.time);
  assert.equal(f.state().pendingTab, true);
  assert.equal('id' in f.state(), false);
  assert.equal('url' in f.owner(), false);
});
test('new expiry closes only its owned background tab; same expiry is not called extended', async () => {
  const f = fixture();
  f.health({ tokenExpiresAt: 1 });
  await f.controller.setEnabled(true);
  const id = f.owner().id;
  f.health({ tokenExpiresAt: f.time + 3600000 });
  await f.controller.relayAccepted(id);
  assert.equal(f.state().status, 'refreshed');
  assert.deepEqual(f.removed, [id]);
  assert.equal(f.state().pendingTab, false);
  const g = fixture();
  g.health({ tokenExpiresAt: g.time + 600000 });
  await g.controller.setEnabled(true);
  await g.controller.relayAccepted(g.owner().id);
  assert.equal(g.state().status, 'valid_unchanged');
  assert.equal(g.removed.length, 1);
  await g.controller.alarm(CHECK_ALARM);
  assert.equal(g.created.length, 1);
  assert.equal(g.state().status, 'cooldown');
  g.advance(15 * 60000);
  await g.controller.alarm(CHECK_ALARM);
  assert.equal(g.created.length, 2);
});
test('a relay from another tab does not prove a maintenance connection when expiry is unchanged', async () => {
  const f = fixture();
  f.health({ tokenExpiresAt: f.time + 600000 });
  await f.controller.setEnabled(true);
  await f.controller.relayAccepted(555);
  assert.equal(f.state().status, 'refreshing');
  assert.equal(f.removed.length, 0);
});
test('timeout removes only a background owned page and applies thirty-minute backoff', async () => {
  const f = fixture();
  f.health({ tokenExpiresAt: 1 });
  await f.controller.setEnabled(true);
  const owner = f.owner();
  f.advance(120000);
  await f.controller.alarm(owner.deadlineName);
  assert.deepEqual(f.removed, [owner.id]);
  assert.equal(f.state().status, 'refresh_failed');
  assert.equal(f.state().retryAt, f.time + 30 * 60000);
  f.advance(15 * 60000);
  await f.controller.alarm(CHECK_ALARM);
  assert.equal(f.created.length, 1);
  f.advance(15 * 60000);
  await f.controller.alarm(CHECK_ALARM);
  assert.equal(f.created.length, 2);
  await f.controller.alarm(owner.deadlineName);
  assert.equal(f.removed.length, 1);
});
test('activation, login redirects, and lost markers surrender ownership without closing or reopening', async () => {
  for (const kind of ['activate', 'login', 'marker']) {
    const f = fixture();
    f.health({ tokenExpiresAt: 1 });
    await f.controller.setEnabled(true);
    const owner = f.owner();
    if (kind === 'activate') {
      f.tabs.get(owner.id).active = true;
      await f.controller.activated(owner.id);
    } else {
      f.tabs.get(owner.id).url =
        kind === 'login'
          ? 'https://login.microsoftonline.com/authorize'
          : 'https://copilot.cloud.microsoft/home';
      await f.controller.updated(owner.id);
    }
    f.advance(3600000);
    await f.controller.alarm(CHECK_ALARM);
    await f.controller.alarm(owner.deadlineName);
    assert.equal(f.state().manualRequired, true, kind);
    assert.equal(f.created.length, 1, kind);
    assert.equal(f.removed.length, 0, kind);
    await f.controller.check({ force: true, resume: true });
    assert.equal(f.created.length, 1, kind);
    f.health({ tokenExpiresAt: f.time + 3600000 });
    await f.controller.check({ allowCreate: false, resume: true });
    assert.equal(f.state().manualRequired, false, kind);
    assert.equal(f.removed.length, 0, kind);
    assert.equal(f.state().pendingTab, false, kind);
  }
});
test('worker restart retains ownership; browser restart never closes a restored or reused tab id', async () => {
  const f = fixture();
  f.health({ tokenExpiresAt: 1 });
  await f.controller.setEnabled(true);
  const id = f.owner().id;
  f.restartWorker();
  await f.controller.initialize();
  assert.equal(f.created.length, 1);
  assert.equal(f.owner().id, id);
  f.restartBrowser();
  await f.controller.initialize();
  assert.equal(f.created.length, 1);
  assert.equal(f.state().manualRequired, true);
  f.health({ tokenExpiresAt: f.time + 3600000 });
  await f.controller.relayAccepted(id);
  assert.equal(f.removed.length, 0);
  assert.equal(f.state().manualRequired, true);
  await f.controller.check({ resume: true, allowCreate: false });
  assert.equal(f.state().pendingTab, false);
  assert.equal(f.removed.length, 0);
});
test('manual refresh works with a fresh session and disabled scheduler, but respects active requests', async () => {
  const f = fixture();
  await f.controller.initialize();
  await f.controller.check({ force: true, resume: true });
  assert.equal(f.created.length, 1);
  assert.equal(f.state().enabled, false);
  const id = f.owner().id;
  await f.controller.relayAccepted(id);
  assert.equal(f.removed.length, 1);
  f.health({ active: 1 });
  await f.controller.check({ force: true });
  assert.equal(f.created.length, 1);
  assert.equal(f.state().status, 'busy');
});
test('explicit disable removes only safe ownership and scheduled checks, never user pages', async () => {
  const f = fixture();
  f.health({ tokenExpiresAt: 1 });
  await f.controller.setEnabled(true);
  await f.controller.setEnabled(false);
  assert.equal(f.removed.length, 1);
  assert.equal(f.alarms.has(CHECK_ALARM), false);
  const g = fixture();
  g.health({ tokenExpiresAt: 1 });
  await g.controller.setEnabled(true);
  const id = g.owner().id;
  g.tabs.get(id).active = true;
  await g.controller.activated(id);
  await g.controller.setEnabled(false);
  assert.equal(g.removed.length, 0);
  assert.equal(g.state().manualRequired, true);
});
test('closed maintenance pages release the block; stale deadline cannot close an unrelated tab', async () => {
  const f = fixture();
  f.health({ tokenExpiresAt: 1 });
  await f.controller.setEnabled(true);
  const owner = f.owner();
  f.tabs.delete(owner.id);
  await f.controller.removed(owner.id);
  await f.controller.alarm(owner.deadlineName);
  assert.equal(f.state().pendingTab, false);
  assert.equal(f.created.length, 1);
  assert.equal(f.removed.length, 0);
});
test('storage and health use explicit metadata allowlists, never raw replies or URLs', async () => {
  const f = fixture();
  f.health({
    access_token: 'never-store-this',
    account: 'private-account',
    url: 'https://example.invalid/?secret=yes',
  });
  await f.controller.setEnabled(true);
  const stored = JSON.stringify(f.local.values) + JSON.stringify(f.session.values);
  assert.equal(stored.includes('never-store'), false);
  assert.equal(stored.includes('private-account'), false);
  assert.equal(stored.includes('secret=yes'), false);
  assert.equal(
    safeHealth({
      ok: true,
      code: 'session_status',
      running: true,
      active: 0,
      tokenExpiresAt: Infinity,
      reloadError: false,
    }),
    null,
  );
  assert.equal(
    isMaintenanceTab({ id: 1, windowId: 2, url: MAINTENANCE_URL, active: false }, { id: 1, windowId: 3 }),
    false,
  );
});
test('manifest requests only existing hosts plus alarms/storage and exposes a local popup', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('./extension/manifest.json', import.meta.url)));
  assert.deepEqual(manifest.permissions, ['webRequest', 'nativeMessaging', 'alarms', 'storage']);
  assert.deepEqual(manifest.host_permissions, [
    'wss://substrate.svc.cloud.microsoft/*',
    'https://copilot.cloud.microsoft/*',
  ]);
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.deepEqual(manifest.optional_permissions, ['scripting']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://login.microsoftonline.com/*']);
});

test('popup status and a passive user-tab relay never open a maintenance tab', async () => {
  const f = fixture();
  await f.controller.setEnabled(true);
  f.health({ tokenExpiresAt: 1 });
  await f.controller.check({ allowCreate: false });
  await f.controller.relayAccepted(777);
  assert.equal(f.created.length, 0);
  assert.equal(f.state().status, 'refresh_failed');
});
test('activation received during asynchronous status checking revokes closure immediately', async () => {
  const f = fixture();
  f.health({ tokenExpiresAt: 1 });
  await f.controller.setEnabled(true);
  const id = f.owner().id;
  const originalGet = f.api.tabs.get;
  let release, entered;
  const waiting = new Promise((resolve) => (entered = resolve));
  let calls = 0;
  f.api.tabs.get = async (tabId) => {
    calls++;
    if (calls === 2) {
      entered();
      await new Promise((resolve) => (release = resolve));
    }
    return originalGet(tabId);
  };
  f.health({ tokenExpiresAt: f.time + 3600000 });
  const relay = f.controller.relayAccepted(id);
  await waiting;
  const activation = f.controller.activated(id);
  release();
  await Promise.all([relay, activation]);
  assert.equal(f.removed.length, 0);
  assert.equal(f.state().manualRequired, true);
});
test('foreign navigation received while closure waits revokes ownership', async () => {
  const f = fixture();
  f.health({ tokenExpiresAt: 1 });
  await f.controller.setEnabled(true);
  const id = f.owner().id;
  const originalGet = f.api.tabs.get;
  let release, entered;
  const waiting = new Promise((resolve) => (entered = resolve));
  let calls = 0;
  f.api.tabs.get = async (tabId) => {
    calls++;
    if (calls === 2) {
      entered();
      await new Promise((resolve) => (release = resolve));
    }
    return originalGet(tabId);
  };
  f.health({ tokenExpiresAt: f.time + 3600000 });
  const relay = f.controller.relayAccepted(id);
  await waiting;
  const navigation = f.controller.updated(id, { url: 'https://login.microsoftonline.com/authorize' });
  release();
  await Promise.all([relay, navigation]);
  assert.equal(f.removed.length, 0);
  assert.equal(f.state().manualRequired, true);
});

test('worker wake for a popup repairs alarms without navigating', async () => {
  const f = fixture();
  await f.controller.setEnabled(true);
  f.health({ tokenExpiresAt: 1 });
  f.restartWorker();
  await f.controller.initialize({ allowCreate: false });
  assert.equal(f.created.length, 0);
  assert.equal(f.alarms.has(CHECK_ALARM), true);
});

const pickerURL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=4765445b-32c6-49b0-83e6-1d93765276ca&redirect_uri=https%3A%2F%2Fcopilot.cloud.microsoft%2Flandingv2&response_type=code';
const selectedAccount = 'v-example@example.invalid';
async function prepareAccount(f) {
  await f.controller.setAccountSettings({ enabled: true, account: selectedAccount });
  f.health({ tokenExpiresAt: 1 });
  await f.controller.setEnabled(true);
  return f.owner().id;
}
test('saved account settings are opt-in, exact and confined to a separate private setting', async () => {
  const f = fixture();
  assert.deepEqual(await f.controller.getAccountSettings(), { version: 1, enabled: false, account: '' });
  await assert.rejects(f.controller.setAccountSettings({ enabled: true, account: 'v-' }));
  const settings = await f.controller.setAccountSettings({ enabled: true, account: '  V-Example@Example.Invalid  ' });
  assert.equal(settings.account, selectedAccount);
  assert.deepEqual(f.local.values[ACCOUNT_KEY], settings);
  assert.equal(JSON.stringify(f.state() || {}).includes(selectedAccount), false);
});
test('account picker accepts only the captured Copilot authorization application and return URI', () => {
  assert.equal(isAccountPickerURL(pickerURL), true);
  for (const value of [
    pickerURL.replace('https:', 'http:'), pickerURL.replace('login.microsoftonline.com', 'other.invalid'),
    pickerURL.replace('common/oauth2/v2.0/authorize', 'common/login'),
    pickerURL.replace('4765445b', '4765445c'), pickerURL.replace('landingv2', 'other'),
    pickerURL + '&client_id=extra', pickerURL + '&redirect_uri=https://example.invalid/',
    pickerURL.replace('response_type=code', 'response_type=token'),
  ]) assert.equal(isAccountPickerURL(value), false);
});
test('only the owned inactive login page selects once and closes after its own successful relay', async () => {
  const calls = [];
  const f = fixture(async (id, account) => { calls.push({ id, account }); return { code: 'selected' }; });
  const id = await prepareAccount(f);
  f.tabs.get(id).url = pickerURL;
  await f.controller.updated(id, { url: pickerURL, status: 'complete' });
  assert.deepEqual(calls, [{ id, account: selectedAccount }]);
  assert.equal(f.owner().accountClickClaimed, true);
  await f.controller.updated(id, { status: 'complete' });
  await f.controller.check();
  assert.equal(calls.length, 1);
  f.tabs.get(id).url = 'https://copilot.cloud.microsoft/home';
  await f.controller.updated(id, { url: f.tabs.get(id).url, status: 'complete' });
  f.health({ tokenExpiresAt: f.time + 3600000 });
  await f.controller.relayAccepted(999);
  assert.equal(f.removed.length, 0);
  await f.controller.relayAccepted(id);
  assert.deepEqual(f.removed, [id]);
  assert.equal(f.state().status, 'refreshed');
  assert.equal(JSON.stringify(f.owner() || {}).includes(selectedAccount), false);
});
test('account mismatch, extra challenge, missing permission and timeout preserve login pages', async () => {
  for (const code of ['not_found', 'ambiguous', 'manual_required', 'user_active']) {
    const f = fixture(async () => ({ code }));
    const id = await prepareAccount(f);
    f.tabs.get(id).url = pickerURL;
    await f.controller.updated(id, { url: pickerURL, status: 'complete' });
    assert.equal(f.state().manualRequired, true, code);
    assert.deepEqual(f.removed, []);
  }
  const f = fixture(async () => ({ code: 'selected' }));
  const id = await prepareAccount(f);
  f.tabs.get(id).url = pickerURL;
  await f.controller.updated(id, { url: pickerURL, status: 'complete' });
  f.advance(120000);
  await f.controller.alarm(f.owner().deadlineName);
  assert.equal(f.state().manualRequired, true);
  assert.deepEqual(f.removed, []);
});
test('existing user pages and unapproved OAuth applications never trigger account selection', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { code: 'selected' }; });
  const id = await prepareAccount(f);
  f.tabs.set(999, { id: 999, windowId: 1, active: false, url: pickerURL });
  await f.controller.updated(999, { url: pickerURL, status: 'complete' });
  f.tabs.get(id).url = pickerURL.replace('4765445b', '4765445c');
  await f.controller.updated(id, { url: f.tabs.get(id).url, status: 'complete' });
  assert.equal(calls, 0);
  assert.equal(f.state().manualRequired, true);
});
test('claimed account selections survive worker restart without a second click', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { code: 'selected' }; });
  const id = await prepareAccount(f);
  f.tabs.get(id).url = pickerURL;
  f.session.values[OWNER_KEY].accountClickClaimed = true;
  f.restartWorker();
  await f.controller.initialize();
  assert.equal(calls, 0);
  assert.equal(f.state().manualRequired, true);
  assert.deepEqual(f.removed, []);
});

test('loading login pages and popup status queries do not spend the one account click', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { code: 'selected' }; });
  const id = await prepareAccount(f);
  f.tabs.get(id).url = pickerURL;
  f.tabs.get(id).status = 'loading';
  await f.controller.updated(id, { url: pickerURL });
  await f.controller.check();
  assert.equal(f.owner().accountClickClaimed, false);
  f.tabs.get(id).status = 'complete';
  await f.controller.check({ allowCreate: false });
  assert.equal(calls, 0);
  await f.controller.updated(id, { status: 'complete' });
  assert.equal(calls, 1);
});
test('activation or foreign navigation during account selection permanently revokes the lease', async () => {
  for (const kind of ['activation', 'navigation', 'settings']) {
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const f = fixture(async () => { entered(); await new Promise(resolve => { release = resolve; }); return { code: 'selected' }; });
    const id = await prepareAccount(f);
    f.tabs.get(id).url = pickerURL;
    const selection = f.controller.updated(id, { url: pickerURL, status: 'complete' });
    await waiting;
    const change = kind === 'activation' ? f.controller.activated(id)
      : kind === 'navigation' ? f.controller.updated(id, { url: 'https://example.invalid/' })
      : f.controller.setAccountSettings({ enabled: false, account: selectedAccount });
    release();
    await Promise.all([selection, change]);
    assert.equal(f.state().manualRequired, true, kind);
    assert.deepEqual(f.removed, []);
  }
});

test('worker warmup replays disallowed navigation before any account selection', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { code: 'selected' }; });
  const id = await prepareAccount(f);
  f.tabs.get(id).url = pickerURL;
  const originalGet = f.session.get;
  let release, entered, first = true;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.session.get = async key => {
    if (first) { first = false; entered(); await new Promise(resolve => { release = resolve; }); }
    return originalGet(key);
  };
  f.restartWorker();
  const initialize = f.controller.initialize({ allowCreate: false });
  await waiting;
  const away = f.controller.updated(id, { url: 'https://copilot.cloud.microsoft/home' });
  const back = f.controller.updated(id, { url: pickerURL, status: 'complete' });
  release();
  await Promise.all([initialize, away, back]);
  assert.equal(calls, 0);
  assert.equal(f.state().manualRequired, true);
  assert.deepEqual(f.removed, []);
});

test('injection authorization becomes false immediately after activation or lease expiry', async () => {
  for (const kind of ['activation', 'expiry', 'disable']) {
    let entered, release, authorized;
    const waiting = new Promise(resolve => { entered = resolve; });
    const f = fixture(async (_id, _account, isAuthorized) => {
      assert.equal(isAuthorized(), true);
      entered(); await new Promise(resolve => { release = resolve; });
      authorized = isAuthorized();
      return { code: authorized ? 'selected' : 'manual_required' };
    });
    const id = await prepareAccount(f);
    f.tabs.get(id).url = pickerURL;
    const selecting = f.controller.updated(id, { url: pickerURL, status: 'complete' });
    await waiting;
    const activation = kind === 'activation' ? f.controller.activated(id)
      : kind === 'disable' ? f.controller.setEnabled(false) : null;
    if (kind === 'expiry') f.advance(120000);
    release();
    await Promise.all([selecting, activation]);
    assert.equal(authorized, false);
    assert.equal(f.state().manualRequired, true);
  }
});

test('script authorization requires the exact active attempt and is consumed only once', async () => {
  let f;
  f = fixture(async (id, _account, _authorized, nonce) => {
    const request = { tabId: id, windowId: 1, active: false, incognito: false, nonce, url: pickerURL };
    for (const patch of [{ nonce: '0'.repeat(32) }, { tabId: 999 }, { windowId: 2 }, { active: true },
      { incognito: true }, { url: 'https://example.invalid/' }]) {
      assert.equal(f.controller.authorizeAccountClick({ ...request, ...patch }), false);
    }
    assert.equal(f.controller.authorizeAccountClick(request), true);
    assert.equal(f.controller.authorizeAccountClick(request), false);
    return { code: 'selected' };
  });
  const id = await prepareAccount(f);
  f.tabs.get(id).url = pickerURL;
  await f.controller.updated(id, { url: pickerURL, status: 'complete' });
  assert.equal(f.owner().accountSelected, true);
});

test('an injected script cannot receive click authorization after user takeover', async () => {
  let f, takeover;
  f = fixture(async (id, _account, _authorized, nonce) => {
    takeover = f.controller.activated(id);
    assert.equal(f.controller.authorizeAccountClick({ tabId: id, windowId: 1, active: false,
      incognito: false, nonce, url: pickerURL }), false);
    return { code: 'manual_required' };
  });
  const id = await prepareAccount(f);
  f.tabs.get(id).url = pickerURL;
  await f.controller.updated(id, { url: pickerURL, status: 'complete' });
  await takeover;
  assert.equal(f.state().manualRequired, true);
});
