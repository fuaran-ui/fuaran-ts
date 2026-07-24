// The TypeScript reference implementation's adapter — the worked example for
// CONFORMANCE.md, and exactly the wiring a third party writes for its own
// host. Run from packages/conformance/ after `pnpm build`:
//
//   node dist/cli.js examples/fuaran-ts-ops.adapter.mjs
//
import { decodeNode, decodeOp, encodeNode, encodeOp } from '@fuaran-ui/ops';

export const adapter = { decodeNode, encodeNode, decodeOp, encodeOp };
export const implementation = { name: '@fuaran-ui/ops', version: '0.1.0' };
