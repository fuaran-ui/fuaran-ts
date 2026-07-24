// The wire-format round-trip panel.
//
// "Show JSON" runs `encodeNode(tree)` from @fuaran-ui/ops and renders the
// canonical JSON. "Load from JSON" runs `decodeNode(input)`; on success it
// hands the decoded `Node` back to the host to render in place, and on failure
// it surfaces the structured `DecodeError` (code + `$`-rooted path + message).
//
// Note: closures (onClick handlers, Query accessors) serialise to a "<closure>"
// sentinel and cannot be recovered — so the decoded tree renders with identical
// structure + static content but inert interactivity. That is the expected,
// documented behaviour of the wire contract, demonstrated live here.

import { useState, type ReactElement } from 'react';

import { decodeNode, encodeNode, type DecodeError } from '@fuaran-ui/ops';
import type { Node } from '@fuaran-ui/schema';

export interface DevToolsProps {
  /** The authored tree to encode. */
  readonly tree: Node<unknown>;
  /** Called with a successfully-decoded tree to render in place. */
  readonly onLoad: (tree: Node<unknown>) => void;
  /** True when a decoded tree is currently being rendered instead of the authored one. */
  readonly overriding: boolean;
  /** Reset back to the authored tree. */
  readonly onReset: () => void;
}

const prettyEncode = (tree: Node<unknown>): string => {
  // encodeNode emits canonical (compact) JSON; re-indent for human reading.
  try {
    return JSON.stringify(JSON.parse(encodeNode(tree)), null, 2);
  } catch {
    return encodeNode(tree);
  }
};

export function DevTools({ tree, onLoad, overriding, onReset }: DevToolsProps): ReactElement {
  const [json, setJson] = useState('');
  const [error, setError] = useState<DecodeError | null>(null);

  const showJson = (): void => {
    setJson(prettyEncode(tree));
    setError(null);
  };

  const loadJson = (): void => {
    const result = decodeNode(json);
    if (result.ok) {
      setError(null);
      onLoad(result.value);
    } else {
      setError(result.error);
    }
  };

  return (
    <aside className="demo-panel" aria-label="Wire-format round-trip">
      <h2>Wire-format round-trip</h2>
      <div className="demo-panel-body">
        <p className="demo-muted">
          Encode the authored tree to canonical JSON, edit it, and decode it back. A failed decode
          surfaces the structured <code>DecodeError</code>.
        </p>

        <div className="demo-panel-row">
          <button className="demo-btn" type="button" onClick={showJson}>
            Show JSON
          </button>
          <button
            className="demo-btn ghost"
            type="button"
            onClick={loadJson}
            disabled={json === ''}
          >
            Load from JSON
          </button>
        </div>

        <textarea
          aria-label="Canonical JSON"
          spellCheck={false}
          value={json}
          placeholder="Press “Show JSON” to encode the authored tree, or paste a Fuaran node tree here…"
          onChange={(e) => setJson(e.target.value)}
        />

        {error !== null && (
          <div className="demo-decode-error" role="alert">
            <strong>Decode failed</strong>
            <div>
              <code>{error.code}</code> at <code>{error.path}</code>
            </div>
            <div>{error.message}</div>
            {error.expectedShape !== undefined && (
              <div>
                expected: <code>{error.expectedShape}</code>
              </div>
            )}
          </div>
        )}

        {overriding && (
          <button className="demo-btn ghost" type="button" onClick={onReset}>
            ↺ Reset to authored tree
          </button>
        )}
      </div>
    </aside>
  );
}
