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
function fixture() {
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
        const tab = { id: nextId++, windowId: 1, active: options.active, incognito: false, url: options.url };
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
  const options = { now: () => time, statusRequest: async () => structuredClone(reply) };
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
