// Codex SDK -> Claude Agent SDK compatibility stream.
//
// The orchestration engine predates the Codex backend and consumes the small subset of Claude's
// streaming protocol mapped below. Keeping this adapter narrow lets both providers share the
// battle-tested task/worktree/CI/review lifecycle without making either SDK leak into Foreman.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Codex, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { codexRuntimeEnv } from './auth.js';

interface QueryArgs {
  prompt: string | AsyncIterable<unknown>;
  options?: Options;
}

type CompatMessage = Record<string, unknown>;

function definedEnv(env: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
}

function textOfPrompt(prompt: QueryArgs['prompt']): string {
  if (typeof prompt !== 'string') throw new Error('Codex backend requires a text prompt');
  return prompt;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/** Expose one turn's in-process AgentCraft MCP server to the Codex child on loopback. */
async function serveMcp(options: Options): Promise<{ url?: string; close(): Promise<void> }> {
  const config = options.mcpServers?.agentcraft as { instance?: McpServer } | undefined;
  if (!config?.instance) return { close: async () => undefined };
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await config.instance.connect(transport);
  const server = http.createServer((req, res) => {
    void transport.handleRequest(req, res).catch((e: Error) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(e.message);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await transport.close().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function assistant(sessionId: string, content: unknown[]): CompatMessage {
  return { type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { content } };
}

function userResult(sessionId: string, id: string, content: unknown, isError = false): CompatMessage {
  return {
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  };
}

function itemMessages(item: ThreadItem, sessionId: string): CompatMessage[] {
  switch (item.type) {
    case 'agent_message':
      return item.text.trim() ? [assistant(sessionId, [{ type: 'text', text: item.text }])] : [];
    case 'reasoning':
      return item.text.trim() ? [assistant(sessionId, [{ type: 'thinking', thinking: item.text }])] : [];
    case 'command_execution': {
      const input = { command: item.command };
      return [
        assistant(sessionId, [{ type: 'tool_use', id: item.id, name: 'Bash', input }]),
        userResult(sessionId, item.id, item.aggregated_output || `(exit ${item.exit_code ?? '?'})`, item.status === 'failed'),
      ];
    }
    case 'file_change': {
      const files = item.changes.map((c) => `${c.kind}: ${c.path}`).join('\n');
      return [
        assistant(sessionId, [{ type: 'tool_use', id: item.id, name: 'Write', input: { file_path: item.changes[0]?.path ?? '?', content: files } }]),
        userResult(sessionId, item.id, item.status === 'completed' ? files : 'patch failed', item.status === 'failed'),
      ];
    }
    case 'mcp_tool_call': {
      const name = `mcp__${item.server}__${item.tool}`;
      const result = item.result?.content ?? item.error?.message ?? '';
      return [
        assistant(sessionId, [{ type: 'tool_use', id: item.id, name, input: item.arguments }]),
        userResult(sessionId, item.id, result, item.status === 'failed'),
      ];
    }
    case 'web_search':
      return [assistant(sessionId, [{ type: 'tool_use', id: item.id, name: 'WebSearch', input: { query: item.query } }])];
    case 'error':
      return [assistant(sessionId, [{ type: 'text', text: `Error: ${item.message}` }])];
    case 'todo_list':
      return [];
  }

  const runtimeType = String((item as { type?: unknown }).type ?? 'unknown');
  console.warn(`[codex] ignoring unsupported thread item type: ${runtimeType}`);
  return [];
}

function systemAppend(options: Options): string {
  const s = options.systemPrompt;
  return s && typeof s === 'object' && 'append' in s ? String(s.append ?? '') : '';
}

/** Shape-compatible query function injected into the shared orchestration engine. */
export function codexQuery(
  args: QueryArgs,
  makeCodex: (options: ConstructorParameters<typeof Codex>[0]) => Codex = (options) => new Codex(options),
): AsyncIterable<CompatMessage> & { close(): void; accountInfo(): Promise<Record<string, string>> } {
  const abort = args.options?.abortController ?? new AbortController();
  let closeTurn: (() => Promise<void>) | undefined;
  const iterable = {
    close(): void {
      abort.abort();
      void closeTurn?.();
    },
    async accountInfo(): Promise<Record<string, string>> {
      return { apiProvider: 'OpenAI', tokenSource: 'codex login (ChatGPT)' };
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<CompatMessage> {
      const options = args.options ?? {};
      const mcp = await serveMcp(options);
      closeTurn = mcp.close;
      let sessionId = typeof options.resume === 'string' ? options.resume : '';
      let finalResponse = '';
      let completed = false;
      try {
        // Start from an empty MCP table so a user's personal Codex MCP servers cannot leak into
        // an AgentCraft turn. The only server is the ephemeral, agent-scoped one above.
        const configOverrides = ['mcp_servers={}'];
        if (mcp.url) {
          configOverrides.push(
            `mcp_servers.agentcraft.url=${JSON.stringify(mcp.url)}`,
            'mcp_servers.agentcraft.required=true',
            'mcp_servers.agentcraft.default_tools_approval_mode="approve"',
          );
        }
        const codex = makeCodex({
          env: definedEnv(codexRuntimeEnv(options.env as NodeJS.ProcessEnv | undefined)),
          configOverrides,
        });
        const threadOptions = {
          ...(options.model ? { model: options.model } : {}),
          workingDirectory: options.cwd,
          skipGitRepoCheck: false,
          sandboxMode: Array.isArray(options.tools) && (options.tools.includes('Edit') || options.tools.includes('Write')) ? ('workspace-write' as const) : ('read-only' as const),
          approvalPolicy: 'never' as const,
          networkAccessEnabled: false,
          webSearchMode: 'disabled' as const,
          ...(options.effort ? { modelReasoningEffort: options.effort } : {}),
        };
        const thread = sessionId ? codex.resumeThread(sessionId, threadOptions) : codex.startThread(threadOptions);
        const prefix = sessionId ? '' : `${systemAppend(options)}\n\n`;
        const streamed = await thread.runStreamed(`${prefix}${textOfPrompt(args.prompt)}`, { signal: abort.signal });
        for await (const event of streamed.events) {
          if (abort.signal.aborted) break;
          const e = event as ThreadEvent;
          if (e.type === 'thread.started') {
            sessionId = e.thread_id;
            yield { type: 'system', subtype: 'init', session_id: sessionId, model: options.model };
          } else if (e.type === 'item.completed') {
            if (e.item.type === 'agent_message') finalResponse = e.item.text;
            for (const msg of itemMessages(e.item, sessionId)) yield msg;
          } else if (e.type === 'turn.completed') {
            completed = true;
            yield { type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: finalResponse, num_turns: 1 };
          } else if (e.type === 'turn.failed') {
            completed = true;
            yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, errors: [e.error.message], result: e.error.message, num_turns: 1 };
          } else if (e.type === 'error') {
            yield assistant(sessionId, [{ type: 'text', text: `Error: ${e.message}` }]);
          }
        }
        if (!completed && !abort.signal.aborted) {
          yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, errors: ['Codex stream ended without a result'], num_turns: 1 };
        }
      } finally {
        await mcp.close();
      }
    },
  };
  return iterable;
}
