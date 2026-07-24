// fuaran_scaffold — target → the integration boilerplate.
//
// Emits the files that wire Fuaran into an app in one shot: the
// `@fuaran-ui/client` SDK call, the renderer wiring, and the token handling
// for the chosen pattern. The TS/React output typechecks as emitted (asserted
// by this package's tests); the F#/Fable output follows the reference F#
// host's idioms and is a drop-in module for a standard Fable + Feliz app.
//
// Secret posture is baked into the templates: the server-proxied pattern (the
// default) keeps the access token + BYOK key in server-side env, so no secret
// ever reaches the browser bundle; the browser-BYOK pattern accepts only
// runtime-supplied user credentials, never bundled literals.

export type ScaffoldTarget = 'ts-react' | 'fsharp-fable';
export type ScaffoldPattern = 'server-proxied' | 'browser-byok';

export interface ScaffoldArgs {
  /** Which stack to emit boilerplate for. */
  readonly target: ScaffoldTarget;
  /** How credentials reach the endpoint. Default: `server-proxied`. */
  readonly pattern?: ScaffoldPattern | undefined;
}

export interface ScaffoldFile {
  /** Suggested path relative to the consumer's app root. */
  readonly path: string;
  readonly contents: string;
}

export interface ScaffoldResult {
  readonly target: ScaffoldTarget;
  readonly pattern: ScaffoldPattern;
  readonly files: readonly ScaffoldFile[];
  /** The install command(s) for the emitted files' dependencies. */
  readonly install: string;
  readonly notes: readonly string[];
}

const PANEL_SERVER_PROXIED = `// FuaranPanel — a prompt→UI panel over the Fuaran generation endpoint.
// Server-proxied pattern: this component calls YOUR same-origin proxy route
// (see server/fuaranProxy.ts); no access token or provider key exists in the
// browser bundle.

import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { FuaranClient, FuaranSession } from '@fuaran-ui/client';
import { decodeProducedTree } from '@fuaran-ui/client/render';
import { FuaranRenderer } from '@fuaran-ui/renderer';
import type { Node } from '@fuaran-ui/schema';
import '@fuaran-ui/renderer/css';

export function FuaranPanel(): ReactElement {
  // The session holds the produced tree between turns, so each follow-up
  // prompt is a cheap repair diff rather than a from-scratch regeneration.
  const session = useMemo(
    () => new FuaranSession(new FuaranClient({ endpoint: '/api/fuaran' })),
    [],
  );
  const [prompt, setPrompt] = useState('');
  const [tree, setTree] = useState<Node<unknown> | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (): Promise<void> => {
    if (prompt.trim() === '' || busy) return;
    setBusy(true);
    setStatus('generating…');
    const result = await session.next(prompt);
    if (result.kind === 'produced') {
      const decoded = decodeProducedTree(result);
      if (decoded.ok) {
        setTree(decoded.tree);
        setStatus('');
      } else {
        setStatus(\`decode failed at \${decoded.error.path}: \${decoded.error.message}\`);
      }
    } else if (result.kind === 'accessDenied') {
      setStatus(\`access denied: \${result.reason}\`);
    } else {
      setStatus(\`turn failed (\${result.error.stage}): \${result.error.message}\`);
    }
    setBusy(false);
  }, [prompt, busy, session]);

  return (
    <section>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the UI you want…"
          aria-label="Fuaran prompt"
        />
        <button type="submit" disabled={busy}>
          Generate
        </button>
      </form>
      {status !== '' && <p role="status">{status}</p>}
      {tree !== null && <FuaranRenderer tree={tree} />}
    </section>
  );
}
`;

const PROXY_SERVER = `// Same-origin Fuaran proxy — the browser posts a secret-free request body to
// this route; the handler injects the access token + BYOK provider key from
// server-side env and forwards the call to the Fuaran generation endpoint.
// No secret ever reaches the browser bundle.
//
// Framework-agnostic core: adapt to your router (Express / Fastify / Next /
// etc.) by passing the raw request-body string and relaying the returned
// (status, body) pair.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(\`\${name} is not set — configure it in server-side env.\`);
  }
  return value;
}

export async function proxyFuaranRequest(
  rawBody: string,
): Promise<{ status: number; body: string }> {
  const endpoint = requireEnv('FUARAN_ENDPOINT');
  const accessToken = requireEnv('FUARAN_ACCESS_TOKEN');
  const providerKey = requireEnv('FUARAN_PROVIDER_KEY');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { status: 400, body: JSON.stringify({ Message: 'invalid JSON body' }) };
  }

  // Overwrite — never merge — so a client-supplied credential field can
  // neither leak in nor override the server's own.
  const wireBody = { ...parsed, AccessToken: accessToken, ByokKey: providerKey };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: \`Bearer \${accessToken}\`,
    },
    body: JSON.stringify(wireBody),
  });
  return { status: response.status, body: await response.text() };
}
`;

const PANEL_BROWSER_BYOK = `// FuaranPanel — a prompt→UI panel over the Fuaran generation endpoint.
// Browser-BYOK pattern: the USER supplies their own provider key (and access
// token) at runtime — e.g. from a settings form — and the browser calls the
// endpoint directly. NEVER bundle a key or long-lived token into shipped
// code; when in doubt, use the server-proxied pattern instead.

import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { FuaranClient, FuaranSession } from '@fuaran-ui/client';
import { decodeProducedTree } from '@fuaran-ui/client/render';
import { FuaranRenderer } from '@fuaran-ui/renderer';
import type { Node } from '@fuaran-ui/schema';
import '@fuaran-ui/renderer/css';

export interface FuaranPanelProps {
  /** The Fuaran generation endpoint URL. */
  readonly endpoint: string;
  /** The user's paid access token, supplied at runtime. */
  readonly accessToken: string;
  /** The user's OWN provider key, supplied at runtime. */
  readonly providerKey: string;
}

export function FuaranPanel({
  endpoint,
  accessToken,
  providerKey,
}: FuaranPanelProps): ReactElement {
  const session = useMemo(
    () => new FuaranSession(new FuaranClient({ endpoint, accessToken, providerKey })),
    [endpoint, accessToken, providerKey],
  );
  const [prompt, setPrompt] = useState('');
  const [tree, setTree] = useState<Node<unknown> | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (): Promise<void> => {
    if (prompt.trim() === '' || busy) return;
    setBusy(true);
    setStatus('generating…');
    const result = await session.next(prompt);
    if (result.kind === 'produced') {
      const decoded = decodeProducedTree(result);
      if (decoded.ok) {
        setTree(decoded.tree);
        setStatus('');
      } else {
        setStatus(\`decode failed at \${decoded.error.path}: \${decoded.error.message}\`);
      }
    } else if (result.kind === 'accessDenied') {
      setStatus(\`access denied: \${result.reason}\`);
    } else {
      setStatus(\`turn failed (\${result.error.stage}): \${result.error.message}\`);
    }
    setBusy(false);
  }, [prompt, busy, session]);

  return (
    <section>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the UI you want…"
          aria-label="Fuaran prompt"
        />
        <button type="submit" disabled={busy}>
          Generate
        </button>
      </form>
      {status !== '' && <p role="status">{status}</p>}
      {tree !== null && <FuaranRenderer tree={tree} />}
    </section>
  );
}
`;

const PANEL_FSHARP = `module App.FuaranPanel

// A prompt→UI panel over the Fuaran generation endpoint, for a Fable + Feliz
// app. Server-proxied pattern: posts to YOUR same-origin proxy route (which
// injects the access token + BYOK key from server-side env — see the ts-react
// scaffold's server/fuaranProxy.ts for a reference proxy), decodes the
// produced wire tree with the canonical decoder, and renders it with the
// reference renderer.
//
// NuGet: Fuaran.UI · Fuaran.UI.Ops · Fuaran.UI.Renderer · Fable.Fetch · Feliz
// Import the reference stylesheet once in your app entry.

open Fable.Core
open Fable.Core.JsInterop
open Fetch
open Feliz
open Fuaran.UI
open Fuaran.UI.Ops
open Fuaran.UI.Renderer

/// POST the prompt (+ the previous turn's tree, making the turn a cheap
/// repair diff) to the proxy; return the produced tree JSON or an error.
let private generate (prompt: string) (currentTreeJson: string option) : JS.Promise<Result<string, string>> =
    promise {
        let body =
            createObj
                [ "Prompt" ==> prompt
                  match currentTreeJson with
                  | Some t -> "CurrentTreeJson" ==> t
                  | None -> () ]

        let! response =
            fetch
                "/api/fuaran"
                [ Method HttpMethod.POST
                  requestHeaders [ HttpRequestHeaders.ContentType "application/json" ]
                  Body !^(JS.JSON.stringify body) ]

        let! text = response.text ()

        if response.Ok then
            let parsed = JS.JSON.parse text
            return Ok(parsed?TreeJson |> string)
        else
            return Error(sprintf "generation failed (HTTP %d): %s" response.Status text)
    }

[<ReactComponent>]
let FuaranPanel () =
    let prompt, setPrompt = React.useState ""
    let treeJson, setTreeJson = React.useState<string option> None
    let status, setStatus = React.useState ""
    let busy, setBusy = React.useState false

    let run () =
        if prompt.Trim() <> "" && not busy then
            setBusy true
            setStatus "generating…"

            generate prompt treeJson
            |> Promise.iter (fun result ->
                (match result with
                 | Ok json ->
                     setTreeJson (Some json)
                     setStatus ""
                 | Error message -> setStatus message)

                setBusy false)

    let rendered =
        treeJson
        |> Option.map (fun json ->
            // Decode through the canonical codec — the same decoder every
            // conformant host trusts. Dispatch is a no-op until you wire the
            // panel's actions into your app's update loop.
            match JsonDecode.decodeNodeObj json with
            | Ok tree -> Render.renderWithSources BindingResolver.empty ignore tree
            | Error e -> Html.p [ prop.role "status"; prop.text (sprintf "decode failed at %s: %s" e.Path e.Message) ])

    Html.section
        [ prop.children
              [ Html.form
                    [ prop.onSubmit (fun e ->
                          e.preventDefault ()
                          run ())
                      prop.children
                          [ Html.input
                                [ prop.value prompt
                                  prop.onChange setPrompt
                                  prop.placeholder "Describe the UI you want…"
                                  prop.ariaLabel "Fuaran prompt" ]
                            Html.button [ prop.type' "submit"; prop.disabled busy; prop.text "Generate" ] ]
                      ]
                if status <> "" then
                    Html.p [ prop.role "status"; prop.text status ]
                match rendered with
                | Some el -> el
                | None -> Html.none ] ]
`;

export function runScaffold(args: ScaffoldArgs): ScaffoldResult {
  const pattern: ScaffoldPattern = args.pattern ?? 'server-proxied';

  if (args.target === 'fsharp-fable') {
    return {
      target: 'fsharp-fable',
      pattern: 'server-proxied',
      files: [{ path: 'src/FuaranPanel.fs', contents: PANEL_FSHARP }],
      install:
        'dotnet add package Fuaran.UI && dotnet add package Fuaran.UI.Ops && ' +
        'dotnet add package Fuaran.UI.Renderer && dotnet add package Fable.Fetch && ' +
        'dotnet add package Feliz',
      notes: [
        'The F#/Fable leg is always server-proxied: pair it with a proxy route that injects FUARAN_ENDPOINT / FUARAN_ACCESS_TOKEN / FUARAN_PROVIDER_KEY from server-side env (the ts-react scaffold emits a reference proxy in server/fuaranProxy.ts).',
        'Add FuaranPanel.fs to your .fsproj compile order and adjust the module namespace to your app.',
        'Import the Fuaran reference stylesheet once in your app entry.',
      ],
    };
  }

  if (pattern === 'browser-byok') {
    return {
      target: 'ts-react',
      pattern,
      files: [{ path: 'src/fuaran/FuaranPanel.tsx', contents: PANEL_BROWSER_BYOK }],
      install:
        'npm install @fuaran-ui/client @fuaran-ui/renderer @fuaran-ui/ops @fuaran-ui/schema react react-dom',
      notes: [
        'Browser-BYOK: the endpoint, access token, and provider key are props supplied at RUNTIME (e.g. from a settings form the user fills in). Never bundle a key or long-lived token into shipped code.',
        'When in doubt, prefer the server-proxied pattern (the default).',
      ],
    };
  }

  return {
    target: 'ts-react',
    pattern,
    files: [
      { path: 'src/fuaran/FuaranPanel.tsx', contents: PANEL_SERVER_PROXIED },
      { path: 'server/fuaranProxy.ts', contents: PROXY_SERVER },
    ],
    install:
      'npm install @fuaran-ui/client @fuaran-ui/renderer @fuaran-ui/ops @fuaran-ui/schema react react-dom',
    notes: [
      'Wire server/fuaranProxy.ts into your server router at POST /api/fuaran (pass the raw body string; relay the returned status + body).',
      'Set FUARAN_ENDPOINT, FUARAN_ACCESS_TOKEN, and FUARAN_PROVIDER_KEY in server-side env — they never appear client-side.',
      'Render <FuaranPanel /> anywhere in your React tree.',
    ],
  };
}
