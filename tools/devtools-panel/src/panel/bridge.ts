// ============================================================================
//  bridge (panel side) — a promise-per-request client over the background
//  router. Each request carries the inspected tab id; responses correlate by
//  the envelope id.
// ============================================================================

import {
  bridgeRequest,
  isBridgeResponse,
  type BridgeMethod,
  type BridgeResponse,
} from '../protocol.js';

export class PanelBridge {
  private readonly port: chrome.runtime.Port;
  private readonly tabId: number;
  private readonly pending = new Map<number, (response: BridgeResponse) => void>();
  private nextId = 1;

  constructor(tabId: number) {
    this.tabId = tabId;
    this.port = chrome.runtime.connect({ name: 'fuaran-devtools-panel' });
    this.port.onMessage.addListener((message: unknown) => {
      if (!isBridgeResponse(message)) return;
      const resolve = this.pending.get(message.id);
      if (resolve !== undefined) {
        this.pending.delete(message.id);
        resolve(message);
      }
    });
    this.port.onDisconnect.addListener(() => {
      for (const [id, resolve] of this.pending) {
        this.pending.delete(id);
        resolve({
          source: 'fuaran-devtools',
          direction: 'response',
          id,
          ok: false,
          error: 'Bridge disconnected.',
        });
      }
    });
  }

  /** Send one request; resolves with the result or rejects with the error message. */
  request<T>(method: BridgeMethod, args?: Readonly<Record<string, unknown>>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (response) => {
        if (response.ok) resolve(response.result as T);
        else reject(new Error(response.error));
      });
      this.port.postMessage({ tabId: this.tabId, request: bridgeRequest(id, method, args) });
    });
  }
}
