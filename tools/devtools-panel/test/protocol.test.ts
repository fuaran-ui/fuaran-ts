import { describe, expect, it } from 'vitest';

import {
  bridgeErr,
  bridgeOk,
  bridgeRequest,
  isBridgeRequest,
  isBridgeResponse,
} from '../src/protocol.js';

describe('bridge envelopes', () => {
  it('round-trips a request through the guard', () => {
    const request = bridgeRequest(7, 'getNodeState', { nodeId: 'submit-btn' });
    expect(isBridgeRequest(request)).toBe(true);
    expect(isBridgeResponse(request)).toBe(false);
    expect(request.args?.['nodeId']).toBe('submit-btn');
  });

  it('round-trips both response shapes through the guard', () => {
    expect(isBridgeResponse(bridgeOk(7, { detected: true }))).toBe(true);
    expect(isBridgeResponse(bridgeErr(7, 'boom'))).toBe(true);
    expect(isBridgeRequest(bridgeOk(7, {}))).toBe(false);
  });

  it('rejects unrelated postMessage traffic', () => {
    expect(isBridgeRequest(undefined)).toBe(false);
    expect(
      isBridgeRequest({ source: 'someone-else', direction: 'request', id: 1, method: 'ping' }),
    ).toBe(false);
    expect(isBridgeResponse({ source: 'fuaran-devtools', direction: 'response' })).toBe(false);
    expect(isBridgeRequest('fuaran-devtools')).toBe(false);
  });

  it('serialises cleanly (everything crossing the bridge is JSON-safe)', () => {
    const request = bridgeRequest(1, 'opStreamTreeAt', { streamId: 'guest-a', sequence: 3 });
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
  });
});
