import { createMaintenance, HOME, isAccountPickerURL } from './maintenance.mjs';
import { selectSavedAccount } from './account-picker.mjs';
const NATIVE_HOST = 'local.codex.copilot_session_relay';
const ACCOUNT_PERMISSION = {
  permissions: ['scripting'],
  origins: ['https://login.microsoftonline.com/*'],
};
const ACCOUNT_RESULTS = new Set(['selected', 'not_found', 'ambiguous', 'manual_required', 'wrong_origin', 'user_active']);
// Account preferences are private to extension pages and the service worker.
// Optional injected functions must never receive storage access.
const trustedStorage = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
trustedStorage.catch(() => {});
const TARGET_PATH = /^\/m365Copilot\/StreamHub\/[0-9a-f-]+@[0-9a-f-]+$/i;
const FILTER = {
  urls: ['wss://substrate.svc.cloud.microsoft/m365Copilot/StreamHub/*'],
  types: ['websocket'],
};
function nativeMessage(message) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 10000);
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (reply) => {
        clearTimeout(timeout);
        resolve(chrome.runtime.lastError ? null : reply);
      });
    } catch {
      clearTimeout(timeout);
      resolve(null);
    }
  });
}
const maintenance = createMaintenance(chrome, {
  statusRequest: () => nativeMessage({ version: 1, type: 'copilot-session-status' }),
  selectAccount: async (tabId, account, isAuthorized = () => false, attemptNonce) => {
    try {
      if (typeof attemptNonce !== 'string' || !/^[a-f0-9]{32}$/.test(attemptNonce))
        return { code: 'manual_required' };
      await trustedStorage;
      if (!isAuthorized()) return { code: 'manual_required' };
      const permitted = await chrome.permissions.contains(ACCOUNT_PERMISSION);
      if (!isAuthorized() || !permitted) return { code: 'manual_required' };
      const tab = await chrome.tabs.get(tabId);
      if (!isAuthorized()) return { code: 'manual_required' };
      if (tab.active || tab.incognito) return { code: 'user_active' };
      if (!isAccountPickerURL(tab.pendingUrl || tab.url)) return { code: 'wrong_origin' };
      if (!isAuthorized()) return { code: 'manual_required' };
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] }, world: 'ISOLATED',
        func: selectSavedAccount, args: [account, attemptNonce],
      });
      const result = results.find(item => item.frameId === 0)?.result;
      return { code: ACCOUNT_RESULTS.has(result?.code) ? result.code : 'manual_required' };
    } catch {
      return { code: 'manual_required' };
    }
  },
});
function background(task) {
  Promise.resolve(task).catch(() => console.info('[copilot-session-relay] Local operation unavailable.'));
}
// URL credentials are passed only to the native host, never stored or logged.
async function receiveConnection(details) {
  if (
    details.type !== 'websocket' ||
    typeof details.url !== 'string' ||
    details.url.length > 65536 ||
    details.incognito === true
  )
    return;
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return;
  }
  if (
    url.protocol !== 'wss:' ||
    url.hostname !== 'substrate.svc.cloud.microsoft' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !TARGET_PATH.test(url.pathname)
  )
    return;
  const tokens = url.searchParams.getAll('access_token');
  if (tokens.length !== 1 || !tokens[0] || tokens[0].length > 32768 || /[\s\x00-\x1f\x7f]/.test(tokens[0]))
    return;
  const reply = await nativeMessage({
    version: 1,
    type: 'copilot-streamhub-session',
    url: url.href,
    capturedAt: new Date().toISOString(),
  });
  if (reply?.ok === true) {
    console.info('[copilot-session-relay] Local session update accepted.');
    background(maintenance.relayAccepted(details.tabId));
  } else console.info('[copilot-session-relay] Local relay unavailable or update rejected.');
}
chrome.webRequest.onBeforeRequest.addListener((details) => background(receiveConnection(details)), FILTER);
chrome.alarms.onAlarm.addListener((alarm) => background(maintenance.alarm(alarm.name)));
chrome.tabs.onActivated.addListener((info) => background(maintenance.activated(info.tabId)));
chrome.tabs.onDetached.addListener((tabId) => background(maintenance.activated(tabId)));
chrome.tabs.onUpdated.addListener((id, change) => {
  if ('url' in change || change.status === 'complete') background(maintenance.updated(id, change));
});
chrome.tabs.onRemoved.addListener((id) => background(maintenance.removed(id)));
chrome.runtime.onInstalled.addListener(() => background(trustedStorage.then(() => maintenance.initialize())));
chrome.runtime.onStartup.addListener(() => background(trustedStorage.then(() => maintenance.initialize())));
chrome.permissions.onRemoved.addListener(() => background(trustedStorage.then(async () => {
  if (await chrome.permissions.contains(ACCOUNT_PERMISSION)) return;
  const settings = await maintenance.getAccountSettings();
  if (settings.enabled) await maintenance.setAccountSettings({ enabled: false, account: settings.account });
})));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'account-click-authorize') {
    let ok = false;
    if (sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0
        && typeof sender.documentId === 'string' && sender.documentId.length > 0
        && isAccountPickerURL(sender.url)
        && typeof message.nonce === 'string' && /^[a-f0-9]{32}$/.test(message.nonce)) {
      try {
        ok = maintenance.authorizeAccountClick({
          tabId: sender.tab.id, windowId: sender.tab.windowId,
          active: sender.tab.active, incognito: sender.tab.incognito,
          nonce: message.nonce, url: sender.url,
        }) === true;
      } catch {}
    }
    respond({ ok });
    return false;
  }
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('popup.html'))
    return false;
  let operation, responseKey = 'state';
  if (message?.type === 'maintenance-status') operation = maintenance.check({ allowCreate: false });
  else if (message?.type === 'maintenance-enabled' && typeof message.enabled === 'boolean')
    operation = maintenance.setEnabled(message.enabled);
  else if (message?.type === 'maintenance-check')
    operation = maintenance.check({ allowCreate: false, resume: true });
  else if (message?.type === 'maintenance-refresh')
    operation = maintenance.check({ force: true, resume: true });
  else if (message?.type === 'maintenance-open')
    operation = chrome.tabs.create({ url: HOME, active: true }).then(() => maintenance.getState());
  else if (message?.type === 'account-settings') {
    responseKey = 'settings';
    operation = trustedStorage.then(() => maintenance.getAccountSettings());
  } else if (message?.type === 'account-save' && typeof message.enabled === 'boolean' && typeof message.account === 'string') {
    responseKey = 'settings';
    operation = trustedStorage.then(async () => {
      if (message.enabled && !await chrome.permissions.contains(ACCOUNT_PERMISSION)) throw new Error();
      return maintenance.setAccountSettings({ enabled: message.enabled, account: message.account });
    });
  }
  else return false;
  operation.then(
    (value) => respond({ ok: true, [responseKey]: value }),
    () => respond({ ok: false }),
  );
  return true;
});
// A worker wake (for example opening the popup) repairs alarms but never
// initiates browser navigation. Startup/install/alarm handlers decide that.
background(trustedStorage.then(() => maintenance.initialize({ allowCreate: false })));
