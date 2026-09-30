import { record } from '../config.ts';
export type AgentEvent =
  | { type: 'session'; id: string }
  | { type: 'tool'; name: string; detail?: string }
  | { type: 'text'; text: string }
  | { type: 'error'; message: string };
export type AgentOptions = { sessionId?: string; model?: string; extraArgs?: string[]; images?: string[] };
export interface AgentSpec {
  name: string; command: string;
  output?: 'text';
  args(o: AgentOptions): string[];
  parseLine(obj: unknown): AgentEvent[];
}
export { record };
export const blocks = (v: unknown) => Array.isArray(v) ? v.map(record) : [];
export const textBlocks = (v: unknown) => blocks(v).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
export const detail = (v: unknown): string | undefined => typeof v === 'string' ? v.slice(0, 200) : undefined;
