// ============================================================================
//  Core twin — the op-stream actor and its canonical encoding (Phase 320),
//  moved behind the core-twins boundary in Phase 1861; @fuaran-ui/op-stream
//  re-exports every name below.
//
//  The actor is the `Fuaran.Core.OpStream.Actor` contract: who authored an op.
//  Its canonical encoding is folded into the op-record hash, so it must stay
//  byte-for-byte aligned with the reference `Actor.encode` on every host.
//  Pure: no imports at all.
// ============================================================================

/**
 * Who authored an op (Phase 320 — typed attested provenance). The Human/Agent
 * distinction is the load-bearing AI-accountability fact; `model`/`version`
 * doubles as corpus-quality metadata. Port of F# `Fuaran.UI.OpStream.Abstractions.Actor`
 * (and the `Fuaran.Core.OpStream.Actor` contract) — the canonical encoding
 * (`encodeActor`, below) is folded into the op-record hash, so the
 * cross-host hashed pre-image is byte-identical.
 */
export type Actor =
  | { readonly kind: 'human'; readonly id: string }
  | {
      readonly kind: 'agent';
      readonly model: string;
      readonly version: string;
      readonly id: string;
    };

/** The stable attribution id — the user id (human) or the agent id (agent). */
export const actorId = (a: Actor): string => a.id;

/** Lift a pre-320 bare-string actor to the typed `human` case. */
export const humanActor = (id: string): Actor => ({ kind: 'human', id });

/**
 * Canonical JSON string escaping — only `"` / `\` / control chars (control as
 * `\u00xx`), matching F# `CanonicalJson.appendRawString` / `StreamEntry` `jstr`
 * so every hashed pre-image is byte-identical across hosts.
 */
export const jsonString = (s: string): string => {
  let out = '"';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    const code = s.charCodeAt(i);
    if (c === '"') {
      out += '\\"';
    } else if (c === '\\') {
      out += '\\\\';
    } else if (code < 0x20) {
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else {
      out += c;
    }
  }
  return out + '"';
};

/**
 * Canonical JSON encoding of the typed actor — folded into the op-record hash
 * (Phase 320). Field order is pinned (kind first, then case fields). MUST stay
 * byte-for-byte aligned with F# / Core `Actor.encode`.
 */
export const encodeActor = (a: Actor): string =>
  a.kind === 'human'
    ? `{"kind":"human","id":${jsonString(a.id)}}`
    : `{"kind":"agent","model":${jsonString(a.model)},"version":${jsonString(a.version)},"id":${jsonString(a.id)}}`;
