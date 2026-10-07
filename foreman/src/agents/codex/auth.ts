import { execFile } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

export type CodexAuthResult = { ok: true; account: string } | { ok: false; message: string };

export const CODEX_API_KEY_VARS = ['OPENAI_API_KEY', 'CODEX_API_KEY'];

/** Force the Codex child runtime to use its local ChatGPT login, never an inherited API key. */
export function codexRuntimeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of Object.keys(out)) if (CODEX_API_KEY_VARS.includes(key.toUpperCase())) delete out[key];
  return out;
}

/** Accept only the ChatGPT-plan login reported by `codex login status`. */
export function parseCodexAuthStatus(error: Error | null, stdout: string, stderr: string): CodexAuthResult {
  const loggedIn = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => /^logged in/i.test(s));
  if (!error && loggedIn) {
    const account = loggedIn.replace(/^logged in(?: using| with)?\s*/i, '') || 'unknown account';
    if (/chatgpt/i.test(account)) return { ok: true, account };
    return { ok: false, message: `Codex is logged in with ${account}, not ChatGPT` };
  }
  return { ok: false, message: (error?.message || stderr || stdout || 'not logged in').trim().split(/\r?\n/).pop()! };
}

function codexBin(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js');
}

/** Fast, inference-free check against the same pinned Codex runtime the SDK uses. */
export function checkCodexAuth(): Promise<CodexAuthResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [codexBin(), 'login', 'status'],
      { windowsHide: true, timeout: 15_000, env: codexRuntimeEnv() },
      (error, stdout, stderr) => resolve(parseCodexAuthStatus(error, stdout, stderr)),
    );
  });
}
