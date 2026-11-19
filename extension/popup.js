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
send({ type: 'maintenance-status' });
// Keep an open popup current while the background page loads and the native
// relay completes, without issuing extra native status requests.
chrome.storage.onChanged.addListener((changes, area) => {
  const state = changes.copilotMaintenance?.newValue;
  if (area === 'local' && state?.version === 1) render(state);
});
