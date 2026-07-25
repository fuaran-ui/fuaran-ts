// @fuaran-ui/cli — the shared command core.
//
// `run(argv)` implements every subcommand and returns an exit code + captured
// output, so the same core drives the `fuaran` bin AND the tests (no process
// spawning). It reuses the already-tested tool implementations from
// @fuaran-ui/mcp (validate / recipe / scaffold) and the @fuaran-ui/client SDK
// (generate) — the CLI is a thin shell over the same surfaces the MCP exposes,
// so `fuaran <cmd>` and the MCP tool behave identically.
//
// Secret hygiene: the access token + BYOK key are read from the process
// environment only (never a flag, never echoed). `--mock` needs no secret.

import { readFileSync } from 'node:fs';

import { FuaranClient } from '@fuaran-ui/client';
import {
  readConfigFromEnv,
  runGenerate,
  runRecipe,
  listRecipes,
  runScaffold,
  runValidate,
  type ScaffoldTarget,
  type ScaffoldPattern,
} from '@fuaran-ui/mcp';

/** The result of a CLI invocation: a process exit code and the text to print. */
export interface RunResult {
  readonly code: number;
  readonly out: string;
}

const USAGE = `fuaran — the Fuaran generative-UI CLI

Usage:
  fuaran generate <prompt> [--tree <file>] [--mock [url]]   Prompt -> a canonical tree
  fuaran validate <file>                                    Wire JSON -> pass/fail + diagnostics
  fuaran recipe <query...>                                  Query -> a matching cookbook recipe
  fuaran scaffold --target ts|fsharp [--pattern server-proxied|browser-byok]

Secrets: FUARAN_ENDPOINT / FUARAN_ACCESS_TOKEN / FUARAN_PROVIDER_KEY are read from
the environment (never a flag, never printed). --mock needs no secret.`;

/** Read a flag's value: `--name value`. Returns undefined when absent. */
function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function has(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

/** Positional args (everything that is not a flag or a flag's value). */
function positionals(argv: readonly string[], flagsWithValue: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      if (flagsWithValue.includes(a)) i += 1; // skip its value
      continue;
    }
    out.push(a);
  }
  return out;
}

async function cmdGenerate(argv: string[]): Promise<RunResult> {
  const prompt = positionals(argv, ['--tree', '--mock']).join(' ').trim();
  if (prompt === '') return { code: 2, out: 'generate: a prompt is required.\n' };

  const treeFile = flag(argv, '--tree');
  const currentTreeJson = treeFile !== undefined ? readFileSync(treeFile, 'utf8') : undefined;

  if (has(argv, '--mock')) {
    const url = flag(argv, '--mock') ?? 'http://127.0.0.1:8123';
    const client = new FuaranClient({ endpoint: url });
    const result = await client.generate({
      prompt,
      ...(currentTreeJson !== undefined ? { currentTreeJson } : {}),
    });
    if (result.kind === 'produced') return { code: 0, out: `${result.treeJson}\n` };
    if (result.kind === 'accessDenied')
      return { code: 1, out: `access denied: ${result.reason}\n` };
    return {
      code: 1,
      out: `turn failed [${result.error.stage}/${result.error.code}]: ${result.error.message}\n`,
    };
  }

  const result = await runGenerate(
    { prompt, ...(currentTreeJson !== undefined ? { currentTreeJson } : {}) },
    readConfigFromEnv(),
  );
  switch (result.status) {
    case 'produced':
      return { code: 0, out: `${result.treeJson}\n` };
    case 'accessDenied':
      return { code: 1, out: `access denied: ${result.reason}\n` };
    case 'failed':
      return { code: 1, out: `turn failed [${result.stage}/${result.code}]: ${result.message}\n` };
    case 'notConfigured':
      return {
        code: 2,
        out: `not configured — set: ${result.missing.join(', ')}\n(or use --mock for offline)\n`,
      };
  }
}

function cmdValidate(argv: string[]): RunResult {
  const file = positionals(argv, []).at(0);
  if (file === undefined) return { code: 2, out: 'validate: a file is required.\n' };
  const json = readFileSync(file, 'utf8');
  const result = runValidate({ json });
  if (result.valid) return { code: 0, out: `valid (${result.kind})\n` };
  const lines = result.diagnostics.map((d) => `  ${d.code} at ${d.path}: ${d.message}`);
  return { code: 1, out: `invalid (${result.kind}):\n${lines.join('\n')}\n` };
}

function cmdRecipe(argv: string[]): RunResult {
  const query = positionals(argv, []).join(' ').trim();
  if (query === '') return { code: 2, out: 'recipe: a query is required.\n' };
  const result = runRecipe({ query });
  if (result.match === null) {
    const names = listRecipes()
      .map((r) => `  ${r.tag} — ${r.title}`)
      .join('\n');
    return {
      code: 1,
      out: `no recipe matched "${query}". Available (${result.available}):\n${names}\n`,
    };
  }
  const m = result.match;
  const alts = result.alternates.map((a) => `  ${a.tag} — ${a.title}`).join('\n');
  return {
    code: 0,
    out:
      `${m.tag} — ${m.title}\n\n${m.expresses}\n\nCanonical prompts:\n` +
      m.prompts.map((p) => `  - ${p}`).join('\n') +
      `\n\nTarget emission (F#):\n${m.emissionFsharp}\n` +
      (alts !== '' ? `\nAlternates:\n${alts}\n` : ''),
  };
}

function cmdScaffold(argv: string[]): RunResult {
  const targetArg = flag(argv, '--target');
  const map: Record<string, ScaffoldTarget> = {
    ts: 'ts-react',
    'ts-react': 'ts-react',
    fsharp: 'fsharp-fable',
    'fsharp-fable': 'fsharp-fable',
  };
  if (targetArg === undefined || map[targetArg] === undefined) {
    return { code: 2, out: 'scaffold: --target ts|fsharp is required.\n' };
  }
  const pattern = (flag(argv, '--pattern') as ScaffoldPattern | undefined) ?? 'server-proxied';
  const result = runScaffold({ target: map[targetArg], pattern });
  const files = result.files.map((f) => `// ==== ${f.path} ====\n${f.contents}`).join('\n\n');
  return {
    code: 0,
    out: `# scaffold: ${result.target} (${result.pattern})\n# install: ${result.install}\n\n${files}\n\nNotes:\n${result.notes.map((n) => `  - ${n}`).join('\n')}\n`,
  };
}

/** Run the CLI. Returns an exit code + the text to print; never throws for a
 *  usage/endpoint error (those become a code + message). */
export async function run(argv: readonly string[]): Promise<RunResult> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'generate':
        return await cmdGenerate(rest);
      case 'validate':
        return cmdValidate(rest);
      case 'recipe':
        return cmdRecipe(rest);
      case 'scaffold':
        return cmdScaffold(rest);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        return { code: 0, out: `${USAGE}\n` };
      default:
        return { code: 2, out: `unknown command "${command}".\n\n${USAGE}\n` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: 1, out: `error: ${message}\n` };
  }
}
