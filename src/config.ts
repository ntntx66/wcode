import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { readJson } from './store.ts';

export const VERSION = '0.1.0';
export const names = ['claude', 'codex', 'pi'] as const;
export type AgentName = typeof names[number];
export type AgentConfig = { command: string; extraArgs: string[] };
export type Config = {
  defaultAgent: AgentName; projects: Record<string, string>;
  agents: Record<AgentName, AgentConfig>; turnTimeoutMinutes: number; mobilePreamble: boolean;
};
export const dataDir = () => process.env.WCODE_HOME || join(homedir(), '.wcode');
export const isAgent = (v: unknown): v is AgentName => names.includes(v as AgentName);
export const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function directory(value: string): string {
  const path = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(path) || !statSync(path).isDirectory()) throw new Error(`不是有效的绝对目录：${value}`);
  return realpathSync(path);
}
export function loadConfig(home: string): Config {
  const raw = readJson(join(home, 'config.json'), {});
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.json 必须是对象');
  const c = record(raw), agents = {} as Config['agents'], projects: Record<string, string> = Object.create(null);
  for (const key of ['agents', 'projects']) if (c[key] !== undefined && (c[key] === null || typeof c[key] !== 'object' || Array.isArray(c[key])))
    throw new Error(`${key} 必须是对象`);
  const defaultAgent = c.defaultAgent ?? 'claude';
  if (!isAgent(defaultAgent)) throw new Error('defaultAgent 必须是 claude、codex 或 pi');
  for (const name of names) {
    const value = record(c.agents)[name];
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new Error(`agents.${name} 必须是对象`);
    const a = record(record(c.agents)[name]);
    const command = a.command ?? name, extraArgs = a.extraArgs ?? [];
    if (typeof command !== 'string' || !command.trim() || !Array.isArray(extraArgs) || extraArgs.some(x => typeof x !== 'string'))
      throw new Error(`agents.${name} 配置无效`);
    agents[name] = { command, extraArgs };
  }
  for (const [name, path] of Object.entries(record(c.projects))) {
    if (typeof path !== 'string') throw new Error(`projects.${name} 必须是路径`);
    projects[name] = directory(path);
  }
  const turnTimeoutMinutes = c.turnTimeoutMinutes ?? 60, mobilePreamble = c.mobilePreamble ?? true;
  if (typeof turnTimeoutMinutes !== 'number' || !Number.isFinite(turnTimeoutMinutes) || turnTimeoutMinutes <= 0 || turnTimeoutMinutes * 60_000 > 2_147_483_647)
    throw new Error('turnTimeoutMinutes 必须是有效的正数（最多 35791 分钟）');
  if (typeof mobilePreamble !== 'boolean') throw new Error('mobilePreamble 必须是布尔值');
  return { defaultAgent, projects, agents, turnTimeoutMinutes, mobilePreamble };
}
