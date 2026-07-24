// @fuaran-ui/op-stream — hash-chained op-stream persistence + replay for the
// Fuaran UI wire format.
//
// Canonical import:
//   import { InMemorySink, applyAndPersist, replayStream, verifyChain } from '@fuaran-ui/op-stream';
//   import type { OpRecord, IOpStreamSink, PersistContext } from '@fuaran-ui/op-stream';
//
// The TypeScript port of Fuaran.UI.OpStream.{Abstractions,InMemory,Replay}.
// Every applied TreeOp becomes an append-only, SHA-256-chained OpRecord whose
// hash is bit-identical to the F# tier over the same op sequence (the chain
// consumes @fuaran-ui/ops's canonical encoder for input determinism), so a
// TS-authored stream is a full op-history peer of the F# tier — replayable and
// tamper-evident (FGP 5: the op stream is the source of truth).

export type {
  OpRecord,
  OpResultEnvelope,
  Actor,
  Checkpoint,
  IOpStreamSink,
  IOpStreamCheckpointSink,
  VerificationError,
  ReplayError,
  ApplyError,
} from './types.js';

export { actorId, humanActor } from './types.js';

export {
  genesisPreviousHash,
  sha256Hex,
  computeHash,
  verifyChain,
  encodeActor,
  encodeResult,
  encodeStreamEntry,
} from './hashChain.js';

export { InMemorySink, createInMemorySink } from './inMemorySink.js';

export { applyTo, replayStream, applyAndPersist, type PersistContext } from './replay.js';

export {
  decodeTeleport,
  defaultTeleportLimits,
  TELEPORT_FORMAT_PREFIX,
  TELEPORT_VERSION,
  type TeleportLimits,
  type TeleportError,
  type DecodedTeleport,
} from './teleport.js';
