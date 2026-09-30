import { detail, record, textBlocks } from './types.ts';
import type { AgentSpec } from './types.ts';
export const pi: AgentSpec = {
  name: 'pi', command: 'pi',
  args(o) {
    if (!o.sessionId) throw new Error('pi 需要预先生成 sessionId');
    return ['--mode', 'json', '--session-id', o.sessionId, ...(o.model ? ['--model', o.model] : []), ...(o.extraArgs ?? []), ...(o.images ?? []).map(path => `@${path}`)];
  },
  parseLine(value) {
    const o = record(value), message = record(o.message);
    if (o.type === 'session' && typeof o.id === 'string') return [{ type: 'session', id: o.id }];
    if (o.type === 'tool_execution_start' && typeof o.toolName === 'string')
      return [{ type: 'tool', name: o.toolName, detail: detail(record(o.args).command ?? record(o.args).path) }];
    if (o.type === 'message_end' && message.role === 'assistant') {
      if (message.stopReason === 'error' || message.stopReason === 'aborted') return [{ type: 'error', message: String(message.errorMessage ?? message.stopReason) }];
      const text = textBlocks(message.content);
      if (text) return [{ type: 'text', text }];
    }
    return [];
  },
};
