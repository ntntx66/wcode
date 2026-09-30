import { detail, record } from './types.ts';
import type { AgentSpec } from './types.ts';
export const codex: AgentSpec = {
  name: 'codex', command: 'codex',
  args: o => ['exec', ...(o.sessionId ? ['resume'] : []), '--json', '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox', ...(o.model ? ['-m', o.model] : []),
    ...(o.extraArgs ?? []), ...(o.images ?? []).flatMap(path => ['-i', path]), ...(o.sessionId ? [o.sessionId] : []), '-'],
  parseLine(value) {
    const o = record(value), item = record(o.item);
    if (o.type === 'thread.started' && typeof o.thread_id === 'string') return [{ type: 'session', id: o.thread_id }];
    if (o.type === 'item.started' && typeof item.type === 'string' && !['agent_message', 'reasoning'].includes(item.type))
      return [{ type: 'tool', name: String(item.tool ?? item.type), detail: detail(item.command) }];
    if (o.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') return [{ type: 'text', text: item.text }];
    // `error` also describes recoverable reconnects; only turn.failed is terminal.
    if (o.type === 'turn.failed') return [{ type: 'error', message: String(record(o.error).message ?? 'turn failed') }];
    return [];
  },
};
