import type { AgentConfig } from '../config.ts';
import type { AgentSpec } from './types.ts';

// Text CLIs are intentionally stateless: stdin is the prompt, stdout is the reply.
export function textAgent(name: string, config: AgentConfig): AgentSpec {
  return { name, command: config.command, output: 'text', parseLine: () => [], args(o) {
    const args = [...(config.args ?? []), ...config.extraArgs];
    if (o.model && !args.some(arg => arg.includes('{model}'))) throw new Error(`${name} 未配置 {model} 参数`);
    return args.map(arg => arg.replaceAll('{model}', o.model ?? ''));
  } };
}
