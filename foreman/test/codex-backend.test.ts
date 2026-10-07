import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CodexBackend } from '../src/agents/codex/index.js';
import { codexRuntimeEnv, parseCodexAuthStatus } from '../src/agents/codex/auth.js';
import { codexQuery } from '../src/agents/codex/query.js';
import { makeForeman, rmrf, tempDir } from './helpers.js';

let home: string | undefined;
afterEach(() => {
  if (home) rmrf(home);
  home = undefined;
});

describe('codex backend', () => {
  it('accepts only a ChatGPT login and removes API keys case-insensitively', () => {
    expect(parseCodexAuthStatus(null, 'Logged in using ChatGPT\n', '')).toEqual({ ok: true, account: 'ChatGPT' });
    expect(parseCodexAuthStatus(null, 'Logged in using an API key\n', '')).toEqual({
      ok: false,
      message: 'Codex is logged in with an API key, not ChatGPT',
    });
    expect(codexRuntimeEnv({ OPENAI_API_KEY: 'openai', codex_api_key: 'codex', PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });

  it('uses the codex identity and reports a successful login probe', async () => {
    home = tempDir();
    const h = makeForeman(home, ['--backend', 'codex', '--workers', 'kit']);
    const backend = new CodexBackend(h.fm, h.cfg.codex, { authCheck: async () => ({ ok: true, account: 'ChatGPT' }) });
    try {
      await h.fm.start(backend);
      expect(backend.name).toBe('codex');
      expect(h.fm.status).toMatchObject({ backend: 'codex', auth: 'ok', account: 'ChatGPT', message: 'Codex ready' });
      expect(h.fm.agent('kit')?.active).toBe(true);
    } finally {
      await h.fm.close();
    }
  });

  it('propagates a failed auth probe into the shared goal and scheduling guard', async () => {
    home = tempDir();
    const h = makeForeman(home, ['--backend', 'codex', '--workers', 'kit']);
    let authOk = false;
    const backend = new CodexBackend(h.fm, h.cfg.codex, {
      authCheck: async () => (authOk ? { ok: true, account: 'ChatGPT' } : { ok: false, message: 'not logged in' }),
    });
    try {
      await h.fm.start(backend);
      const blocked = h.fm.createGoal('must not start');
      await expect(backend.submitGoal(blocked)).rejects.toThrow(/Codex is not available/);
      expect(blocked.status).toBe('failed');

      authOk = true;
      expect(await backend.checkAuth()).toBe(true);
      const unblocked = h.fm.createGoal('may reach normal validation');
      await expect(backend.submitGoal(unblocked)).rejects.toThrow(/repo/);
      expect(unblocked.status).toBe('planning');
    } finally {
      await h.fm.close();
    }
  });

  it('maps Codex thread events into the shared orchestration stream', async () => {
    async function* events() {
      yield { type: 'thread.started', thread_id: 'thread-1' };
      yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Done.' } };
      yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
    }
    let constructorOptions: Record<string, unknown> | undefined;
    const fakeCodex = {
      startThread: () => ({ runStreamed: async () => ({ events: events() }) }),
      resumeThread: () => ({ runStreamed: async () => ({ events: events() }) }),
    };
    const stream = codexQuery(
      {
        prompt: 'work',
        options: {
          cwd: process.cwd(),
          model: 'gpt-test',
          env: { OPENAI_API_KEY: 'openai-secret', CODEX_API_KEY: 'codex-secret', PATH: '/bin' },
        },
      },
      (options) => {
        constructorOptions = options as Record<string, unknown>;
        return fakeCodex as never;
      },
    );
    expect(await stream.accountInfo()).toMatchObject({ tokenSource: 'codex login (ChatGPT)' });
    const messages = [];
    for await (const message of stream) messages.push(message);
    expect(constructorOptions).not.toHaveProperty('apiKey');
    expect(constructorOptions?.env).toEqual({ PATH: '/bin' });
    expect(messages).toEqual([
      expect.objectContaining({ type: 'system', subtype: 'init', session_id: 'thread-1' }),
      expect.objectContaining({ type: 'assistant', session_id: 'thread-1' }),
      expect.objectContaining({ type: 'result', subtype: 'success', session_id: 'thread-1', result: 'Done.' }),
    ]);
  });

  it('ignores unsupported Codex thread items without aborting the turn', async () => {
    async function* events() {
      yield { type: 'thread.started', thread_id: 'thread-unknown' };
      yield { type: 'item.completed', item: { id: 'future-1', type: 'future_item', payload: { value: 1 } } };
      yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Done after unknown item.' } };
      yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
    }

    const fakeCodex = {
      startThread: () => ({ runStreamed: async () => ({ events: events() }) }),
      resumeThread: () => ({ runStreamed: async () => ({ events: events() }) }),
    };

    const stream = codexQuery(
      { prompt: 'work', options: { cwd: process.cwd(), model: 'gpt-test' } },
      () => fakeCodex as never,
    );

    const messages = [];
    for await (const message of stream) messages.push(message);

    expect(messages).toEqual([
      expect.objectContaining({ type: 'system', subtype: 'init', session_id: 'thread-unknown' }),
      expect.objectContaining({ type: 'assistant', session_id: 'thread-unknown' }),
      expect.objectContaining({
        type: 'result',
        subtype: 'success',
        session_id: 'thread-unknown',
        result: 'Done after unknown item.',
      }),
    ]);
  });
  it('pre-approves only the ephemeral AgentCraft MCP server while keeping global approvals disabled', async () => {
    const server = new McpServer({ name: 'agentcraft-test', version: '1.0.0' });
    let writes = 0;
    server.registerTool(
      'write_memory',
      { description: 'Disposable write smoke test', annotations: { readOnlyHint: false } },
      async () => {
        writes++;
        return { content: [{ type: 'text', text: 'written' }] };
      },
    );
    let sessionId: string | undefined;
    let threadOptions: Record<string, unknown> | undefined;
    const fakeCodex = (configOverrides: string[]) => ({
      startThread: (options: Record<string, unknown>) => ({
        runStreamed: async () => {
          const prefix = 'mcp_servers.agentcraft.url=';
          const urlOverride = configOverrides.find((value) => value.startsWith(prefix));
          expect(urlOverride).toBeDefined();
          expect(configOverrides).toEqual([
            'mcp_servers={}',
            urlOverride,
            'mcp_servers.agentcraft.required=true',
            'mcp_servers.agentcraft.default_tools_approval_mode="approve"',
          ]);
          expect(configOverrides.filter((value) => value.includes('approval_mode'))).toEqual([
            'mcp_servers.agentcraft.default_tools_approval_mode="approve"',
          ]);
          threadOptions = options;
          const client = new Client({ name: 'agentcraft-test-client', version: '1.0.0' });
          const transport = new StreamableHTTPClientTransport(new URL(JSON.parse(urlOverride!.slice(prefix.length))));
          await client.connect(transport);
          sessionId = transport.sessionId;
          expect(await client.callTool({ name: 'write_memory', arguments: {} })).toMatchObject({
            content: [{ type: 'text', text: 'written' }],
          });
          await client.close();
          return { events: events() };
        },
      }),
      resumeThread: () => {
        throw new Error('unexpected resume');
      },
    });
    async function* events() {
      yield { type: 'thread.started', thread_id: 'thread-mcp' };
      yield { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } };
    }

    const stream = codexQuery(
      { prompt: 'work', options: { cwd: process.cwd(), mcpServers: { agentcraft: { type: 'sdk', name: 'agentcraft', instance: server } } as never } },
      (options) => fakeCodex(options?.configOverrides ?? []) as never,
    );
    for await (const _message of stream) {
      // Consuming the stream runs the real initialize + notifications/initialized exchange.
    }

    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(writes).toBe(1);
    expect(threadOptions).toMatchObject({
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
    });
  });
});
