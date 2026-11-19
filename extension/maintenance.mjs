// Scheduling and ownership only. Optional account selection never reads credentials.
export const HOME = 'https://copilot.cloud.microsoft/home';
export const MAINTENANCE_URL = HOME + '#local-copilot-session-maintenance';
export const CHECK_ALARM = 'copilot-session-check';
export const DEADLINE_PREFIX = 'copilot-session-deadline-';
export const STATE_KEY = 'copilotMaintenance';
export const OWNER_KEY = 'copilotMaintenanceOwner';
export const ACCOUNT_KEY = 'copilotSavedAccount';
const COPILOT_CLIENT_ID = '4765445b-32c6-49b0-83e6-1d93765276ca';
function accountSettings(value) {
  const account = typeof value?.account === 'string' ? value.account.trim().toLowerCase() : '';
  const valid = account.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(account);
  return { version: 1, enabled: value?.version === 1 && value.enabled === true && valid,
    account: valid ? account : '' };
}
export function isAccountPickerURL(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://login.microsoftonline.com' && !url.username && !url.password
      && /^\/(?:common|organizations|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/oauth2\/v2\.0\/authorize$/i.test(url.pathname)
      && url.searchParams.getAll('client_id').length === 1
      && url.searchParams.get('client_id') === COPILOT_CLIENT_ID
      && url.searchParams.getAll('redirect_uri').length === 1
      && url.searchParams.get('redirect_uri') === 'https://copilot.cloud.microsoft/landingv2'
      && url.searchParams.getAll('response_type').length === 1
      && url.searchParams.get('response_type') === 'code';
  } catch { return false; }
}
function isReturnURL(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://copilot.cloud.microsoft' && !url.username && !url.password
      && ['/home', '/landingv2'].includes(url.pathname) && !url.search
      && (!url.hash || url.hash === '#local-copilot-session-maintenance');
  } catch { return false; }
}
const MARGIN = 20 * 60 * 1000,
  INTERVAL = 15 * 60 * 1000,
  BACKOFF = 30 * 60 * 1000,
  DEADLINE = 120000;
const STATES = new Set([
  'disabled',
  'healthy',
  'waiting_for_gateway',
  'gateway_error',
  'busy',
  'refreshing',
  'refreshed',
  'valid_unchanged',
  'cooldown',
  'needs_attention',
  'refresh_failed',
]);
const validNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function cleanState(value = {}) {
  const state = {
    version: 1,
    enabled: false,
    status: 'disabled',
    tokenExpiresAt: null,
    running: false,
    active: 0,
    reloadError: false,
    lastCheckedAt: 0,
    lastAttemptAt: 0,
    retryAt: 0,
    lastSuccessAt: 0,
    manualRequired: false,
    pendingTab: false,
  };
  if (!value || typeof value !== 'object' || value.version !== 1) return state;
  for (const key of ['enabled', 'running', 'reloadError', 'manualRequired', 'pendingTab'])
    state[key] = value[key] === true;
  for (const key of ['lastCheckedAt', 'lastAttemptAt', 'retryAt', 'lastSuccessAt'])
    if (validNumber(value[key])) state[key] = value[key];
  if (validNumber(value.tokenExpiresAt)) state.tokenExpiresAt = value.tokenExpiresAt;
  if (Number.isSafeInteger(value.active) && value.active >= 0) state.active = value.active;
  if (STATES.has(value.status)) state.status = value.status;
  return state;
}
function cleanOwner(value) {
  if (
    !value ||
    !Number.isSafeInteger(value.id) ||
    value.id < 0 ||
    !Number.isSafeInteger(value.windowId) ||
    value.windowId < 0 ||
    !validNumber(value.startedAt) ||
    !/^copilot-session-deadline-\d+$/.test(value.deadlineName ?? '')
  )
    return null;
  return {
    id: value.id,
    windowId: value.windowId,
    startedAt: value.startedAt,
    deadlineName: value.deadlineName,
    baselineExpiresAt: validNumber(value.baselineExpiresAt) ? value.baselineExpiresAt : null,
    relayObserved: value.relayObserved === true,
    disowned: value.disowned === true,
    loginAllowed: value.loginAllowed === true,
    accountClickClaimed: value.accountClickClaimed === true,
    accountSelected: value.accountSelected === true,
  };
}
export function isMaintenanceTab(tab, owner) {
  if (!tab || !owner || tab.id !== owner.id || tab.windowId !== owner.windowId || tab.active || tab.incognito)
    return false;
  try {
    const url = new URL(tab.pendingUrl || tab.url);
    return (
      url.origin === 'https://copilot.cloud.microsoft' &&
      url.pathname === '/home' &&
      url.hash === '#local-copilot-session-maintenance'
    );
  } catch {
    return false;
  }
}
export function safeHealth(reply) {
  if (
    reply?.ok !== true ||
    !['session_status', 'gateway_unavailable'].includes(reply.code) ||
    typeof reply.running !== 'boolean' ||
    typeof reply.reloadError !== 'boolean' ||
    !Number.isSafeInteger(reply.active) ||
    reply.active < 0 ||
    !(reply.tokenExpiresAt === null || validNumber(reply.tokenExpiresAt))
  )
    return null;
  return {
    running: reply.running,
    tokenExpiresAt: reply.tokenExpiresAt,
    active: reply.active,
    reloadError: reply.reloadError,
  };
}
export function createMaintenance(api, { now = Date.now, statusRequest, selectAccount } = {}) {
  let tail = Promise.resolve();
  let liveOwner = null;
  let ownerLoaded = false;
  let accountSelectionBlocked = false;
  let activeClick = null;
  const earlyNavigation = new Map();
  const revokedTabs = new Set();
  const enqueue = (task) => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };
  async function load() {
    const [local, session] = await Promise.all([
      api.storage.local.get(STATE_KEY),
      api.storage.session.get(OWNER_KEY),
    ]);
    const state = cleanState(local[STATE_KEY]),
      owner = cleanOwner(session[OWNER_KEY]);
    liveOwner = owner;
    if (!ownerLoaded) {
      // Events can wake the worker before storage.session has been restored.
      // Replay every observed URL before inspecting or using the recovered lease.
      if (owner && (earlyNavigation.get(owner.id) || []).some(url => !allowedURL(url, owner)))
        revokedTabs.add(owner.id);
      earlyNavigation.clear();
      ownerLoaded = true;
    }
    // Never close tabs by numeric IDs saved across browser restarts.
    if (state.pendingTab && !owner) {
      state.manualRequired = true;
      state.status = 'needs_attention';
    }
    return { state, owner };
  }
  async function save(state, owner) {
    liveOwner = owner;
    await api.storage.local.set({ [STATE_KEY]: cleanState(state) });
    if (owner) await api.storage.session.set({ [OWNER_KEY]: cleanOwner(owner) });
    else await api.storage.session.remove(OWNER_KEY);
    await api.action
      .setBadgeText({ text: state.manualRequired ? '!' : state.enabled ? 'ON' : '' })
      .catch(() => {});
    await api.action
      .setBadgeBackgroundColor({ color: state.manualRequired ? '#b45309' : '#166534' })
      .catch(() => {});
  }
  async function getTab(id) {
    try {
      return await api.tabs.get(id);
    } catch {
      return null;
    }
  }
  async function clearOwner(state, owner) {
    if (owner) await api.alarms.clear(owner.deadlineName);
    state.pendingTab = false;
    return null;
  }
  async function disown(state, owner) {
    owner.disowned = true;
    state.manualRequired = true;
    state.pendingTab = true;
    state.status = 'needs_attention';
    await api.alarms.clear(owner.deadlineName);
  }
  const isOwnedBackground = (tab, owner) => tab && owner && tab.id === owner.id
    && tab.windowId === owner.windowId && !tab.active && !tab.incognito
    && !owner.disowned && !revokedTabs.has(owner.id);
  function allowedURL(url, owner) {
    return isMaintenanceTab({ id: owner.id, windowId: owner.windowId, active: false, url }, owner)
      || (owner.loginAllowed && isAccountPickerURL(url))
      || (owner.accountClickClaimed && isReturnURL(url));
  }
  function closeable(tab, owner) {
    return isOwnedBackground(tab, owner) && (isMaintenanceTab(tab, owner)
      || (owner.accountSelected && owner.relayObserved && isReturnURL(tab.pendingUrl || tab.url)
        && new URL(tab.pendingUrl || tab.url).pathname === '/home'));
  }
  async function closeOwned(state, owner) {
    const tab = await getTab(owner.id);
    if (!tab) return clearOwner(state, owner);
    if (!closeable(tab, owner)) {
      await disown(state, owner);
      return owner;
    }
    try {
      await api.tabs.remove(owner.id);
    } catch {
      await disown(state, owner);
      return owner;
    }
    return clearOwner(state, owner);
  }
  async function health(state) {
    let value;
    try {
      value = safeHealth(await statusRequest());
    } catch {}
    state.lastCheckedAt = now();
    if (!value) {
      state.running = false;
      state.status = 'gateway_error';
      return false;
    }
    Object.assign(state, value);
    if (!value.running) state.status = 'waiting_for_gateway';
    return value.running;
  }
  const fresh = (state) => state.running && !state.reloadError && state.tokenExpiresAt > now();
  async function inspect(state, owner) {
    if (!owner) return null;
    const tab = await getTab(owner.id);
    if (!tab) {
      state.manualRequired = false;
      return clearOwner(state, owner);
    }
    if (!isOwnedBackground(tab, owner) || !allowedURL(tab.pendingUrl || tab.url, owner))
      await disown(state, owner);
    return owner;
  }
  async function tryAccount(state, owner) {
    if (!owner || owner.disowned) return;
    let tab = await getTab(owner.id);
    if (!tab || !isAccountPickerURL(tab.pendingUrl || tab.url)) return;
    if (tab.status !== 'complete') return;
    const settings = accountSettings((await api.storage.local.get(ACCOUNT_KEY))[ACCOUNT_KEY]);
    if (!isOwnedBackground(tab, owner) || !owner.loginAllowed || !settings.enabled
        || typeof selectAccount !== 'function' || now() >= owner.startedAt + DEADLINE) {
      await disown(state, owner); return;
    }
    if (owner.accountClickClaimed) {
      // A worker restarted between claim and result must never retry the click.
      if (!owner.accountSelected) await disown(state, owner);
      return;
    }
    owner.accountClickClaimed = true;
    await save(state, owner);
    tab = await getTab(owner.id);
    if (!isOwnedBackground(tab, owner) || !isAccountPickerURL(tab.pendingUrl || tab.url)
        || now() >= owner.startedAt + DEADLINE) {
      await disown(state, owner); return;
    }
    let result;
    const isAuthorized = () => !accountSelectionBlocked && liveOwner?.id === owner.id && liveOwner.accountClickClaimed
      && !liveOwner.disowned && !revokedTabs.has(owner.id) && now() < owner.startedAt + DEADLINE;
    const nonce = crypto.randomUUID().replaceAll('-', '');
    activeClick = { id: owner.id, windowId: owner.windowId, nonce, used: false, isAuthorized };
    try { result = await selectAccount(owner.id, settings.account, isAuthorized, nonce); } catch {}
    finally { activeClick = null; }
    tab = await getTab(owner.id);
    if (result?.code !== 'selected' || !isOwnedBackground(tab, owner)
        || !allowedURL(tab.pendingUrl || tab.url, owner) || now() >= owner.startedAt + DEADLINE) {
      await disown(state, owner); return;
    }
    owner.accountSelected = true;
    await save(state, owner);
  }
  async function check({ allowCreate = true, deadlineName, resume = false, force = false, relayTabId } = {}) {
    let { state, owner } = await load();
    if (deadlineName && (!owner || owner.deadlineName !== deadlineName)) return state;
    owner = await inspect(state, owner);
    if (allowCreate) await tryAccount(state, owner);
    if (owner && relayTabId === owner.id) owner.relayObserved = true;
    const available = await health(state);
    if (resume && state.manualRequired && fresh(state)) {
      // Explicit acknowledgment relinquishes a user-owned page, never closes it.
      owner = await clearOwner(state, owner);
      state.manualRequired = false;
      state.status = state.enabled ? 'healthy' : 'disabled';
      await save(state, owner);
      return state;
    }
    if (!state.enabled && !force && !owner) {
      state.status = 'disabled';
      await save(state, owner);
      return state;
    }
    if (state.manualRequired) {
      state.status = 'needs_attention';
      await save(state, owner);
      return state;
    }
    if (owner) {
      if (fresh(state) && (owner.accountClickClaimed ? owner.accountSelected && owner.relayObserved
          : owner.relayObserved || state.tokenExpiresAt > (owner.baselineExpiresAt ?? 0))) {
        state.status =
          state.tokenExpiresAt > (owner.baselineExpiresAt ?? 0) ? 'refreshed' : 'valid_unchanged';
        state.lastSuccessAt = now();
        owner = await closeOwned(state, owner);
      } else if (deadlineName || now() >= owner.startedAt + DEADLINE) {
        state.status = 'refresh_failed';
        state.retryAt = now() + BACKOFF;
        owner = await closeOwned(state, owner);
      } else state.status = 'refreshing';
      await save(state, owner);
      return state;
    }
    if (!available) {
      await save(state, owner);
      return state;
    }
    if (state.active > 0) {
      state.status = 'busy';
      await save(state, owner);
      return state;
    }
    if (!force && fresh(state) && state.tokenExpiresAt - now() > MARGIN) {
      state.status = 'healthy';
      await save(state, owner);
      return state;
    }
    if (!allowCreate) {
      state.status = fresh(state) ? 'healthy' : 'refresh_failed';
      await save(state, owner);
      return state;
    }
    if (!force && now() < Math.max(state.retryAt, state.lastAttemptAt ? state.lastAttemptAt + INTERVAL : 0)) {
      state.status = 'cooldown';
      await save(state, owner);
      return state;
    }
    // A worker killed after this write cannot silently create duplicate tabs.
    state.lastAttemptAt = now();
    state.pendingTab = true;
    state.status = 'refreshing';
    await save(state, null);
    let tab;
    try {
      tab = await api.tabs.create({ url: MAINTENANCE_URL, active: false });
    } catch {
      state.pendingTab = false;
      state.status = 'refresh_failed';
      state.retryAt = now() + BACKOFF;
      await save(state, null);
      return state;
    }
    owner = {
      id: tab.id,
      windowId: tab.windowId,
      startedAt: state.lastAttemptAt,
      baselineExpiresAt: state.tokenExpiresAt,
      deadlineName: DEADLINE_PREFIX + state.lastAttemptAt,
      relayObserved: false,
      disowned: false,
      loginAllowed: accountSettings((await api.storage.local.get(ACCOUNT_KEY))[ACCOUNT_KEY]).enabled,
      accountClickClaimed: false,
      accountSelected: false,
    };
    if (!cleanOwner(owner)) {
      state.manualRequired = true;
      state.status = 'needs_attention';
      await save(state, null);
      return state;
    }
    await save(state, owner);
    await api.alarms.create(owner.deadlineName, { when: owner.startedAt + DEADLINE });
    return state;
  }
  return {
    authorizeAccountClick: ({ tabId, windowId, active, incognito, nonce, url }) => {
      const claim = activeClick;
      if (!claim || claim.used || nonce !== claim.nonce || tabId !== claim.id
          || windowId !== claim.windowId || active !== false || incognito === true
          || !isAccountPickerURL(url) || !claim.isAuthorized()) return false;
      claim.used = true;
      return true;
    },
    getAccountSettings: () => enqueue(async () => accountSettings((await api.storage.local.get(ACCOUNT_KEY))[ACCOUNT_KEY])),
    setAccountSettings: (value) => {
      accountSelectionBlocked = true;
      // Reconfiguring during an in-flight injection revokes that lease immediately.
      if (liveOwner?.loginAllowed) revokedTabs.add(liveOwner.id);
      return enqueue(async () => {
        const settings = accountSettings({ ...value, version: 1 });
        if (value?.enabled === true && !settings.enabled) throw new Error('invalid_account');
        let { state, owner } = await load();
        if (owner?.loginAllowed) await disown(state, owner);
        await api.storage.local.set({ [ACCOUNT_KEY]: settings });
        if (owner) await save(state, owner);
        accountSelectionBlocked = false;
        return settings;
      });
    },
    initialize: ({ allowCreate = true } = {}) =>
      enqueue(async () => {
        const { state, owner } = await load();
        if (state.enabled) await api.alarms.create(CHECK_ALARM, { periodInMinutes: 5 });
        else await api.alarms.clear(CHECK_ALARM);
        await save(state, owner);
        return check({ allowCreate });
      }),
    getState: () => enqueue(async () => (await load()).state),
    check: (options) => enqueue(() => check(options)),
    alarm: (name) =>
      enqueue(() =>
        name === CHECK_ALARM
          ? check()
          : name.startsWith(DEADLINE_PREFIX)
            ? check({ allowCreate: false, deadlineName: name })
            : undefined,
      ),
    setEnabled: (enabled) => {
      if (enabled !== true) accountSelectionBlocked = true;
      if (enabled !== true && liveOwner?.loginAllowed) revokedTabs.add(liveOwner.id);
      return enqueue(async () => {
        let { state, owner } = await load();
        state.enabled = enabled === true;
        if (state.enabled) await api.alarms.create(CHECK_ALARM, { periodInMinutes: 5 });
        else {
          await api.alarms.clear(CHECK_ALARM);
          if (owner && !owner.disowned) owner = await closeOwned(state, owner);
          state.status = 'disabled';
        }
        await save(state, owner);
        accountSelectionBlocked = false;
        return state.enabled ? check() : state;
      });
    },
    activated: (id) => {
      revokedTabs.add(id);
      return enqueue(async () => {
        const { state, owner } = await load();
        if (owner?.id === id) {
          await disown(state, owner);
          await save(state, owner);
        }
      });
    },
    updated: (id, change = {}) => {
      if (!ownerLoaded && typeof change.url === 'string') {
        const history = earlyNavigation.get(id) || [];
        if (history.length >= 16) revokedTabs.add(id);
        else { history.push(change.url); earlyNavigation.set(id, history); }
      }
      if (
        typeof change.url === 'string' &&
        !(liveOwner?.id === id ? allowedURL(change.url, liveOwner)
          : isMaintenanceTab({ id, windowId: 0, active: false, url: change.url }, { id, windowId: 0 }) || isAccountPickerURL(change.url) || isReturnURL(change.url))
      )
        revokedTabs.add(id);
      return enqueue(async () => {
        let { state, owner } = await load();
        if (owner?.id !== id) return;
        if (typeof change.url === 'string' && !allowedURL(change.url, owner)) {
          revokedTabs.add(id);
          await disown(state, owner);
        }
        owner = await inspect(state, owner);
        if (change.status === 'complete') await tryAccount(state, owner);
        await save(state, owner);
      });
    },
    removed: (id) =>
      enqueue(async () => {
        const { state, owner } = await load();
        if (owner?.id !== id) return;
        state.manualRequired = false;
        state.status = state.enabled ? 'cooldown' : 'disabled';
        await clearOwner(state, owner);
        await save(state, null);
      }),
    relayAccepted: (tabId) => enqueue(() => check({ allowCreate: false, relayTabId: tabId })),
  };
}
