import { blocks, detail, record, textBlocks } from './types.ts';
import type { AgentEvent, AgentSpec } from './types.ts';
export const claude: AgentSpec = {
  name: 'claude', command: 'claude',
  args: o => ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
    ...(o.sessionId ? ['--resume', o.sessionId] : []), ...(o.model ? ['--model', o.model] : []),
    ...(o.system ? ['--append-system-prompt', o.system] : []), ...(o.extraArgs ?? [])],
  parseLine(value) {
    const o = record(value), events: AgentEvent[] = [];
    if (o.type === 'system' && o.subtype === 'init' && typeof o.session_id === 'string') events.push({ type: 'session', id: o.session_id });
    if (o.type === 'assistant' && !o.parent_tool_use_id) {
      for (const b of blocks(record(o.message).content)) if (b.type === 'tool_use' && typeof b.name === 'string')
        events.push({ type: 'tool', name: b.name, detail: detail(record(b.input).command ?? record(b.input).file_path) });
      const text = textBlocks(record(o.message).content);
      if (text) events.push({ type: 'text', text });
    }
    if (o.type === 'result') {
      if (o.is_error) events.push({ type: 'error', message: String(o.result || (Array.isArray(o.errors) ? o.errors.join('\n') : o.subtype)) });
      else if (typeof o.result === 'string') events.push({ type: 'text', text: o.result });
    }
    return events;
  },
};
