const labels = {
  disabled: '自动维护已关闭。正常 Copilot 连接仍会同步会话。',
  healthy: '当前会话有效。',
  waiting_for_gateway: '本机代理未运行；不会自动重新启用它。',
  gateway_error: '无法读取本机状态。请确认代理和原生宿主已更新。',
  busy: '代理正在处理请求，本轮暂缓维护。',
  refreshing: '已打开后台维护页，等待正常会话更新。',
  refreshed: '会话已同步，有效期已延长。',
  valid_unchanged: '会话已同步并有效，本次有效期未延长。',
  cooldown: '等待下一次维护窗口，避免重复打开页面。',
  needs_attention: '需要手动处理登录或维护页面。',
  refresh_failed: '本次未获得有效会话，将稍后重试。',
};
const ids = ['enabled', 'status', 'expiry', 'attention', 'check', 'refresh', 'open'];
const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const accountEl = Object.fromEntries(['form', 'enabled', 'email', 'save', 'status']
  .map(id => [id, document.getElementById('account-' + id)]));
const accountPermission = {
  permissions: ['scripting'],
  origins: ['https://login.microsoftonline.com/*'],
};
let accountDirty = false;
function normalizedAccount(value) {
  const account = value.trim().toLowerCase();
  return account.length <= 254 && /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(account)
    ? account : null;
}
function accountBusy(busy) {
  for (const id of ['enabled', 'email', 'save']) accountEl[id].disabled = busy;
}
function renderAccount(settings, granted = true) {
  accountEl.enabled.checked = settings.enabled === true && granted;
  accountEl.email.value = typeof settings.account === 'string' ? settings.account : '';
  accountEl.status.textContent = settings.enabled && granted
    ? '已开启，仅匹配本机保存的完整账号。'
    : '自动选账号已关闭。启用时 Chrome 会请求登录页访问权限。';
  accountDirty = false;
}
async function loadAccountSettings() {
  accountBusy(true);
  try {
    const [reply, granted] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'account-settings' }),
      chrome.permissions.contains(accountPermission),
    ]);
    if (!reply?.ok || reply.settings?.version !== 1) throw new Error();
    renderAccount(reply.settings, granted);
  } catch {
    accountEl.status.textContent = '无法读取账号设置，请重新打开扩展后再试。';
  } finally {
    accountBusy(false);
  }
}
async function saveAccountSettings(event) {
  event.preventDefault();
  const enabled = accountEl.enabled.checked;
  const rawAccount = accountEl.email.value.trim();
  const account = rawAccount ? normalizedAccount(rawAccount) : '';
  if (account === null || (enabled && !account)) {
    accountEl.status.textContent = '请输入完整登录邮箱，不能只填账号前缀。';
    return;
  }
  accountBusy(true);
  try {
    // Invoke request directly in the submit gesture. Awaiting a preliminary
    // contains() call can lose Chrome's required user-gesture context.
    const permissionRequest = enabled ? chrome.permissions.request(accountPermission) : Promise.resolve(true);
    if (!await permissionRequest) {
      accountEl.status.textContent = '未授予登录页访问权限，账号设置没有更改。';
      return;
    }
    const reply = await chrome.runtime.sendMessage({ type: 'account-save', enabled, account });
    if (!reply?.ok || reply.settings?.version !== 1) throw new Error();
    renderAccount(reply.settings);
  } catch {
    accountEl.status.textContent = '保存失败，账号设置尚未确认，请重试。';
  } finally {
    accountBusy(false);
  }
}
function render(state) {
  el.enabled.checked = state.enabled === true;
  el.status.textContent = labels[state.status] || '无法读取当前状态。';
  el.attention.hidden = !state.manualRequired;
  el.expiry.textContent =
    typeof state.tokenExpiresAt === 'number'
      ? '当前凭据到期时间：' + new Date(state.tokenExpiresAt).toLocaleString()
      : '尚无有效会话时间。首次使用需先导入会话。';
}
async function send(message) {
  for (const id of ['enabled', 'check', 'refresh', 'open']) el[id].disabled = true;
  try {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) throw new Error();
    render(reply.state);
  } catch {
    el.status.textContent = '本机状态暂不可用，请稍后重试。';
  } finally {
    for (const id of ['enabled', 'check', 'refresh', 'open']) el[id].disabled = false;
  }
}
el.enabled.addEventListener('change', () =>
  send({ type: 'maintenance-enabled', enabled: el.enabled.checked }),
);
el.check.addEventListener('click', () => send({ type: 'maintenance-check' }));
el.refresh.addEventListener('click', () => send({ type: 'maintenance-refresh' }));
el.open.addEventListener('click', () => send({ type: 'maintenance-open' }));
accountEl.form.addEventListener('submit', saveAccountSettings);
accountEl.email.addEventListener('input', () => { accountDirty = true; });
accountEl.enabled.addEventListener('change', () => { accountDirty = true; });
send({ type: 'maintenance-status' });
loadAccountSettings();
// Keep an open popup current while the background page loads and the native
// relay completes, without issuing extra native status requests.
chrome.storage.onChanged.addListener((changes, area) => {
  const state = changes.copilotMaintenance?.newValue;
  if (area === 'local' && state?.version === 1) render(state);
  const settings = changes.copilotSavedAccount?.newValue;
  if (area === 'local' && settings?.version === 1 && !accountDirty) renderAccount(settings);
});
