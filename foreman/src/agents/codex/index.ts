// Codex backend: Codex SDK transport over AgentCraft's shared real-agent orchestration engine.
import type { ClaudeConfig, CodexConfig } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import { ClaudeBackend } from '../claude/index.js';
import { checkCodexAuth, type CodexAuthResult } from './auth.js';
import { codexQuery } from './query.js';

export interface CodexBackendOptions {
  authCheck?: () => Promise<CodexAuthResult>;
  queryFn?: typeof codexQuery;
}

export class CodexBackend extends ClaudeBackend {
  private readonly codexFm: Foreman;
  private readonly authCheck: () => Promise<CodexAuthResult>;

  constructor(fm: Foreman, cfg: CodexConfig, opts: CodexBackendOptions = {}) {
    const shared: ClaudeConfig = {
      ...cfg,
      useClaudeLogin: false,
      maxBudgetUsdPerTurn: undefined,
    };
    super(fm, shared, {
      queryFn: (opts.queryFn ?? codexQuery) as never,
      skipAuthCheck: true,
      backendName: 'codex',
      displayName: 'Codex',
    });
    this.codexFm = fm;
    this.authCheck = opts.authCheck ?? checkCodexAuth;
  }

  override async checkAuth(): Promise<boolean> {
    this.codexFm.setStatus({ auth: 'checking', message: 'Checking Codex login...' });
    const result = await this.authCheck();
    if (result.ok) {
      this.clearAuthFailed();
      this.codexFm.setStatus({ auth: 'ok', account: result.account, message: 'Codex ready' });
      this.codexFm.log.info(`codex auth ok (${result.account})`);
      return true;
    }
    const message = `Codex login check failed: ${result.message}. Run \`codex login\`, then restart the Foreman. The sim backend still works.`;
    this.markAuthFailed(message);
    return false;
  }
}
