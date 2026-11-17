'use strict';

const NATIVE_HOST = 'local.codex.copilot_session_relay';
const TARGET_HOST = 'substrate.svc.cloud.microsoft';
const TARGET_PATH = /^\/m365Copilot\/StreamHub\/[0-9a-f-]+@[0-9a-f-]+$/i;
const MAX_URL_LENGTH = 65536;
const REQUEST_FILTER = {
  urls: ['wss://substrate.svc.cloud.microsoft/m365Copilot/StreamHub/*'],
  types: ['websocket'],
};

// Chrome reports WebSocket handshakes through webRequest, not the frames.
// This listener never requests headers, cookies, or request/response bodies.
function receiveConnection(details) {
  if (details.type !== 'websocket' || typeof details.url !== 'string'
      || details.url.length > MAX_URL_LENGTH || details.incognito === true) return;
  let url;
  try { url = new URL(details.url); } catch { return; }
  if (url.protocol !== 'wss:' || url.hostname !== TARGET_HOST || url.port
      || url.username || url.password || url.hash || !TARGET_PATH.test(url.pathname)) return;
  const tokens = url.searchParams.getAll('access_token');
  if (tokens.length !== 1 || !tokens[0] || tokens[0].length > 32768
      || /[\s\x00-\x1f\x7f]/.test(tokens[0])) return;

  // Neither URL nor token is persisted. The native host is the sole recipient.
  // No refresh is attempted: a normal Copilot connection supplies each update.
  try {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, {
      version: 1,
      type: 'copilot-streamhub-session',
      url: url.href,
      capturedAt: new Date().toISOString(),
    }, (reply) => {
      // Reading lastError suppresses Chrome's default error logging. Do not log
      // its message, the reply object, request details, or credential-bearing URL.
      const failed = Boolean(chrome.runtime.lastError);
      if (failed || reply?.ok !== true) {
        console.info('[copilot-session-relay] Local relay unavailable or update rejected.');
      } else {
        console.info('[copilot-session-relay] Local session update accepted.');
      }
    });
  } catch {
    console.info('[copilot-session-relay] Local relay invocation failed.');
  }
}

chrome.webRequest.onBeforeRequest.addListener(receiveConnection, REQUEST_FILTER);
