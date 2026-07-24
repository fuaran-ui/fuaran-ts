// ============================================================================
//  background — the MV3 service-worker router.
//
//  A DevTools panel page cannot message a tab's content scripts directly, so
//  each panel opens a long-lived port here carrying its inspected tab id;
//  every request is forwarded to that tab's content script and the response
//  posted back on the port. Stateless beyond the port lifetime — nothing is
//  cached, nothing is inspected.
// ============================================================================

import { isBridgeRequest } from './protocol.js';

/** The panel→background port message: a bridge request plus its tab. */
interface RoutedRequest {
  readonly tabId: number;
  readonly request: unknown;
}

const isRoutedRequest = (value: unknown): value is RoutedRequest =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as RoutedRequest).tabId === 'number' &&
  isBridgeRequest((value as RoutedRequest).request);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fuaran-devtools-panel') return;

  port.onMessage.addListener((message: unknown) => {
    if (!isRoutedRequest(message)) return;
    const { tabId, request } = message;
    chrome.tabs
      .sendMessage(tabId, request)
      .then((response) => port.postMessage(response))
      .catch((error: unknown) =>
        port.postMessage({
          source: 'fuaran-devtools',
          direction: 'response',
          id: (request as { id: number }).id,
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : 'Could not reach the inspected tab (reload the page after installing the extension).',
        }),
      );
  });
});
