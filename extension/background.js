import { createMaintenance, HOME } from './maintenance.mjs';
const NATIVE_HOST = 'local.codex.copilot_session_relay';
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
chrome.tabs.onUpdated.addListener((id, change) => {
  if ('url' in change || change.status === 'complete') background(maintenance.updated(id, change));
});
chrome.tabs.onRemoved.addListener((id) => background(maintenance.removed(id)));
chrome.runtime.onInstalled.addListener(() => background(maintenance.initialize()));
chrome.runtime.onStartup.addListener(() => background(maintenance.initialize()));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('popup.html'))
    return false;
  let operation;
  if (message?.type === 'maintenance-status') operation = maintenance.check({ allowCreate: false });
  else if (message?.type === 'maintenance-enabled' && typeof message.enabled === 'boolean')
    operation = maintenance.setEnabled(message.enabled);
  else if (message?.type === 'maintenance-check')
    operation = maintenance.check({ allowCreate: false, resume: true });
  else if (message?.type === 'maintenance-refresh')
    operation = maintenance.check({ force: true, resume: true });
  else if (message?.type === 'maintenance-open')
    operation = chrome.tabs.create({ url: HOME, active: true }).then(() => maintenance.getState());
  else return false;
  operation.then(
    (state) => respond({ ok: true, state }),
    () => respond({ ok: false }),
  );
  return true;
});
// A worker wake (for example opening the popup) repairs alarms but never
// initiates browser navigation. Startup/install/alarm handlers decide that.
background(maintenance.initialize({ allowCreate: false }));
