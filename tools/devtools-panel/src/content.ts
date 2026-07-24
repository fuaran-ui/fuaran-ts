// ============================================================================
//  content — the isolated-world relay.
//
//  The MAIN-world hook can reach the page's globals but not the extension
//  APIs; the panel can reach the extension APIs but not the page. This script
//  sits between them: it receives a bridge request from the background router
//  (chrome.runtime message), forwards it into the page via window.postMessage,
//  waits for the hook's matching response id, and completes the message
//  channel with it. Purely a pipe — it never inspects payloads beyond the
//  envelope guard.
// ============================================================================

import { isBridgeRequest, isBridgeResponse, type BridgeResponse } from './protocol.js';

const RESPONSE_TIMEOUT_MS = 5_000;

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response: BridgeResponse) => void) => {
    if (!isBridgeRequest(message)) return false;

    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      sendResponse({
        source: 'fuaran-devtools',
        direction: 'response',
        id: message.id,
        ok: false,
        error: 'The page did not answer (is the Fuaran DevTools hook loaded on this page?).',
      });
    }, RESPONSE_TIMEOUT_MS);

    const onMessage = (event: MessageEvent): void => {
      if (event.source !== window || !isBridgeResponse(event.data) || event.data.id !== message.id)
        return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      sendResponse(event.data);
    };

    window.addEventListener('message', onMessage);
    window.postMessage(message, '*');
    return true; // keep the sendResponse channel open for the async reply
  },
);
