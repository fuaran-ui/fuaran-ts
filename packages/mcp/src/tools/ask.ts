// fuaran_ask — elicitation as an MCP tool (Phase 467).
//
// Any MCP-speaking agent (Claude Code, Cursor, …) gets rich typed elicitation
// without adopting Fuaran first: the calling agent supplies a canonical
// elicitation envelope (a Fuaran wire tree + a typed answer contract — the
// WIRE_FORMAT.md §18 shape the public `@fuaran-ui/ops` codec certifies), this
// tool hosts the rendered question on a local page, blocks until the human
// resolves it, and returns exactly one typed `ElicitationOutcome`.
//
// The tool is a WIRE-FORMAT CLIENT: it consumes the elicitation envelope per the
// public wire-format spec + fixture corpus via `@fuaran-ui/ops`, and renders the
// question with the public `@fuaran-ui/renderer-server` SSR surface — no private
// sibling or package is named (publication-boundary vocabulary rules apply). The
// answer host is offline by construction: it binds only to loopback.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { renderToHtml } from '@fuaran-ui/renderer-server';
import {
  decodeElicitation,
  encodeElicitationOutcome,
  validateAnswer,
  type Answer,
  type AnswerField,
  type AnswerSpace,
  type AnswerValue,
  type ElicitationEnvelope,
  type ElicitationError,
  type ElicitationOutcomeEnvelope,
} from '@fuaran-ui/ops';

export interface AskArgs {
  /** The elicitation envelope as canonical wire JSON (WIRE_FORMAT.md §18). */
  envelope: string;
  /** Loopback port for the answer host. `0` (default) picks an ephemeral port. */
  port?: number | undefined;
}

export type AskResult = { ok: true; outcome: string } | { ok: false; error: ElicitationError };

// ─── HTML helpers ────────────────────────────────────────────────────

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const isNumberSpace = (space: AnswerSpace): boolean =>
  space.kind === 'intRange' || space.kind === 'floatRange';

/** Build the answer input for one contract field, typed by its value space. */
const inputForField = (field: AnswerField): string => {
  const name = escapeHtml(field.name);
  const req = field.required ? ' required' : '';

  switch (field.space.kind) {
    case 'enum': {
      const options = field.space.values
        .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
        .join('');
      return `<label>${name} <select name="${name}"${req}>${options}</select></label>`;
    }
    case 'intRange':
      return `<label>${name} <input type="number" name="${name}" min="${field.space.min}" max="${field.space.max}" step="1"${req} /></label>`;
    case 'floatRange':
      return `<label>${name} <input type="number" name="${name}" min="${field.space.min}" max="${field.space.max}" step="any"${req} /></label>`;
    case 'stringLen':
      return `<label>${name} <input type="text" name="${name}" minlength="${field.space.min}" maxlength="${field.space.max}"${req} /></label>`;
    case 'anyString':
      return `<label>${name} <input type="text" name="${name}"${req} /></label>`;
  }
};

/** The answer-host page: the rendered question tree + a form derived from the
 *  contract, with submit / decline affordances and a client that POSTs the
 *  typed answer back to the loopback host. */
export const buildAnswerPage = (env: ElicitationEnvelope): string => {
  const question = renderToHtml(env.tree);
  const inputs = env.contract.fields.map(inputForField).join('\n      ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Fuaran — a question for you</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
    form { display: grid; gap: 12px; margin-top: 20px; }
    label { display: grid; gap: 4px; font-weight: 600; }
    input, select { padding: 6px 8px; font: inherit; }
    .actions { display: flex; gap: 10px; margin-top: 8px; }
    button { padding: 8px 16px; font: inherit; cursor: pointer; }
    #fuaran-error { color: #b00020; min-height: 1.2em; }
  </style>
</head>
<body>
  <section id="fuaran-question">${question}</section>
  <form id="fuaran-answer">
      ${inputs}
    <div id="fuaran-error" role="alert"></div>
    <div class="actions">
      <button type="submit">Submit</button>
      <button type="button" id="fuaran-decline">Decline</button>
    </div>
  </form>
  <script>
    const form = document.getElementById('fuaran-answer');
    const errorEl = document.getElementById('fuaran-error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.textContent = '';
      const answer = {};
      for (const el of form.elements) { if (el.name) answer[el.name] = el.value; }
      const res = await fetch('/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer }),
      });
      if (res.ok) {
        document.body.innerHTML = '<p>Answer submitted. You can close this window.</p>';
      } else {
        const err = await res.json().catch(() => ({}));
        errorEl.textContent = err.message || 'That answer does not conform to the contract.';
      }
    });
    document.getElementById('fuaran-decline').addEventListener('click', async () => {
      await fetch('/decline', { method: 'POST' });
      document.body.innerHTML = '<p>Declined. You can close this window.</p>';
    });
  </script>
</body>
</html>`;
};

// ─── Answer coercion + contract conformance ──────────────────────────

/** Coerce the submitted `{ name: string }` map into a typed `Answer`, mapping
 *  numeric value spaces through `Number`. Only declared fields are carried. */
export const coerceAnswer = (env: ElicitationEnvelope, raw: Record<string, unknown>): Answer => {
  const answer = new Map<string, AnswerValue>();
  for (const field of env.contract.fields) {
    if (!(field.name in raw)) continue;
    const value = raw[field.name];
    answer.set(field.name, isNumberSpace(field.space) ? Number(value) : String(value));
  }
  return answer;
};

/** Resolve a submitted answer against the contract. A non-conforming answer
 *  cannot become an outcome — the structured `ElicitationError` is returned so
 *  the host re-prompts (the answer never reaches the calling agent). */
export const resolveOutcome = (
  env: ElicitationEnvelope,
  answer: Answer,
): { ok: true; value: ElicitationOutcomeEnvelope } | { ok: false; error: ElicitationError } => {
  const check = validateAnswer(env.contract, answer);
  if (!check.ok) return { ok: false, error: check.error };
  return {
    ok: true,
    value: { elicitationId: env.id, outcome: { kind: 'Answered', answer } },
  };
};

// ─── The loopback answer host ────────────────────────────────────────

export interface ElicitationServerHandle {
  url: string;
  port: number;
  /** Resolves with the one outcome once the human submits / declines / times out. */
  done: Promise<ElicitationOutcomeEnvelope>;
  close: () => void;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });

/** Start the loopback answer host for one elicitation. Resolves with a handle
 *  whose `done` promise settles when the human resolves the question. Binds to
 *  `127.0.0.1` only — no network beyond loopback. */
export const startElicitationServer = (
  env: ElicitationEnvelope,
  opts: { port?: number | undefined } = {},
): Promise<ElicitationServerHandle> => {
  const page = buildAnswerPage(env);

  let settle!: (outcome: ElicitationOutcomeEnvelope) => void;
  const done = new Promise<ElicitationOutcomeEnvelope>((resolve) => {
    settle = resolve;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const finish = (outcome: ElicitationOutcomeEnvelope) => {
      if (timer) clearTimeout(timer);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: outcome.outcome.kind }));
      server.close();
      settle(outcome);
    };

    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }

    if (req.method === 'POST' && req.url === '/decline') {
      finish({ elicitationId: env.id, outcome: { kind: 'Declined' } });
      return;
    }

    if (req.method === 'POST' && req.url === '/resolve') {
      void readBody(req).then((body) => {
        let raw: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(body) as { answer?: Record<string, unknown> };
          raw = parsed.answer ?? {};
        } catch {
          raw = {};
        }
        const resolved = resolveOutcome(env, coerceAnswer(env, raw));
        if (resolved.ok) {
          finish(resolved.value);
        } else {
          res.writeHead(422, { 'content-type': 'application/json' });
          res.end(JSON.stringify(resolved.error));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);

      if (typeof env.timeoutMs === 'number' && env.timeoutMs >= 1) {
        timer = setTimeout(() => {
          server.close();
          settle({ elicitationId: env.id, outcome: { kind: 'TimedOut' } });
        }, env.timeoutMs);
      }

      resolve({
        url: `http://127.0.0.1:${port}/`,
        port,
        done,
        close: () => {
          if (timer) clearTimeout(timer);
          server.close();
        },
      });
    });
  });
};

// ─── The tool entry point ────────────────────────────────────────────

/** Run `fuaran_ask`: validate the envelope (the same wire-codec `fuaran_validate`
 *  trusts), host the rendered question, block until the human resolves it, and
 *  return the encoded typed outcome. `log` receives the loopback URL for the
 *  human to open (stderr in the MCP host — stdout is the protocol channel). */
export const runAsk = async (
  args: AskArgs,
  log: (message: string) => void = (m) => console.error(m),
): Promise<AskResult> => {
  const decoded = decodeElicitation(args.envelope);
  if (!decoded.ok) return { ok: false, error: decoded.error };

  const env = decoded.value;
  const handle = await startElicitationServer(env, { port: args.port });
  log(`fuaran_ask: open ${handle.url} to answer "${env.id}"`);

  const outcome = await handle.done;
  return { ok: true, outcome: encodeElicitationOutcome(outcome) };
};
