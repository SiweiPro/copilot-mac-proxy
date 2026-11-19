/**
 * Optional, one-shot selection of a previously saved account. This function is
 * self-contained so Chrome can serialize it for an isolated-world injection.
 * The worker must separately authorize the current maintenance tab/document.
 * No password, input value, cookie, storage or form body is accessed here.
 */
export async function selectSavedAccount(expectedAccount, attemptNonce) {
  const result = (code) => ({ code });
  const guard = '__localCopilotSavedAccountSelected';
  const normalize = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
  const expected = normalize(expectedAccount);
  if (typeof attemptNonce !== 'string' || !/^[a-f0-9]{32}$/.test(attemptNonce)) return result('manual_required');
  const emailPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/gi;
  if (!expected || expected.length > 254 || !/^[\x21-\x7e]+$/.test(expected)
      || (expected.match(emailPattern) ?? []).length !== 1
      || expected.match(emailPattern)[0] !== expected) return result('manual_required');
  try {
    const authorizedPage = () => {
      const url = new URL(location.href);
      if (window.top !== window || url.origin !== 'https://login.microsoftonline.com'
          || url.username || url.password
          || !/^\/(?:common|organizations|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/oauth2\/v2\.0\/authorize$/i.test(url.pathname)) return false;
      for (const [name, value] of [
        ['client_id', '4765445b-32c6-49b0-83e6-1d93765276ca'],
        ['redirect_uri', 'https://copilot.cloud.microsoft/landingv2'],
        ['response_type', 'code'],
      ]) {
        const values = url.searchParams.getAll(name);
        if (values.length !== 1 || values[0] !== value) return false;
      }
      return true;
    };
    if (!authorizedPage()) return result('wrong_origin');
    const userActive = () => document.visibilityState !== 'hidden' || document.hasFocus();
    if (userActive()) return result('user_active');
    if (document[guard]) return result('manual_required');

    const visible = (element) => {
      if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
      return Array.from(element.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
    };
    const label = (element) => [element.getAttribute('aria-label') ?? '', element.textContent ?? ''].join(' ');
    const disabled = (element) => element.disabled === true || element.hasAttribute('disabled')
      || element.getAttribute('aria-disabled') === 'true';
    const controls = () => Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
    // Account selection has no editable fields. A password, OTP, consent form,
    // or other login step must stay with the user, even if autofilled already.
    const manualStep = (buttons) => {
      if (Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="checkbox"]')).some(visible)) return true;
      const action = /^(?:accept|allow|continue|next|yes|verify|approve|sign in|send code|send a code|同意|接受|允许|继续|下一步|验证|批准|是|登录|发送代码|发送验证码)$/i;
      return buttons.some(button => {
        const values = [button.getAttribute('aria-label') ?? '', button.textContent ?? ''];
        return values.some(value => action.test(value.trim().replace(/\s+/g, ' ')));
      });
    };
    const find = () => {
      const buttons = controls();
      if (manualStep(buttons)) return { code: 'manual_required' };
      const matches = [];
      let ambiguous = false;
      for (const button of buttons) {
        if (disabled(button)) continue;
        const text = label(button);
        const addresses = new Set((text.match(emailPattern) ?? []).map(normalize));
        if (!addresses.has(expected)) continue;
        // An account-bearing delete/manage menu is not an account tile.
        if (/\b(?:remove|delete|forget|manage|edit|sign out|log out)\b|移除|删除|忘记|管理|编辑|注销|退出登录/i.test(text)) {
          return { code: 'manual_required' };
        }
        if (addresses.size !== 1) ambiguous = true;
        else matches.push(button);
      }
      if (ambiguous || matches.length > 1) return { code: 'ambiguous' };
      if (matches.length !== 1) return { code: 'not_found' };
      return { button: matches[0] };
    };
    let revoked = false;
    const revoke = () => { revoked = true; };
    const visibility = () => { if (userActive()) revoked = true; };
    for (const type of ['pointerdown', 'keydown', 'focusin']) document.addEventListener(type, revoke, true);
    document.addEventListener('visibilitychange', visibility, true);
    window.addEventListener('focus', revoke, true);
    try {
      const first = find();
      if (!first.button) return result(first.code);
      // Re-authorize immediately before acting. The worker validates the nonce,
      // current settings and exact tab/document without receiving account data.
      const approval = await chrome.runtime.sendMessage({ type: 'account-click-authorize', nonce: attemptNonce });
      if (approval?.ok !== true) return result('manual_required');
      if (revoked || userActive()) return result('user_active');
      if (!authorizedPage()) return result('wrong_origin');
      if (document[guard]) return result('manual_required');
      const current = find();
      if (!current.button) return result(current.code);
      if (current.button !== first.button) return result('manual_required');
      Object.defineProperty(document, guard, { value: true });
      current.button.click();
      return result('selected');
    } finally {
      for (const type of ['pointerdown', 'keydown', 'focusin']) document.removeEventListener(type, revoke, true);
      document.removeEventListener('visibilitychange', visibility, true);
      window.removeEventListener('focus', revoke, true);
    }
  } catch {
    return result('manual_required');
  }
}
