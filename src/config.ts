import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { readJson } from './json.ts';
import { record, validAgentName } from './values.ts';

export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const names = ['claude', 'codex', 'pi'] as const;
export type AgentName = string;
export type AgentConfig = { command: string; extraArgs: string[]; type?: 'text'; args?: string[] };
export type Config = {
  defaultAgent: AgentName; projects: Record<string, string>;
  agents: Record<AgentName, AgentConfig>; turnTimeoutMinutes: number; mobilePreamble: boolean;
};
export const dataDir = () => resolve(process.env.WCODE_HOME || join(homedir(), '.wcode'));
export const isAgent = (v: unknown): v is typeof names[number] => names.includes(v as typeof names[number]);
export function directory(value: string): string {
  const path = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(path) || !statSync(path).isDirectory()) throw new Error(`不是有效的绝对目录：${value}`);
  return realpathSync(path);
}
export function loadConfig(home: string): Config {
  const raw = readJson(join(home, 'config.json'), {});
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.json 必须是对象');
  const c = record(raw), agents: Config['agents'] = Object.create(null), projects: Record<string, string> = Object.create(null);
  for (const key of ['agents', 'projects']) if (c[key] !== undefined && (c[key] === null || typeof c[key] !== 'object' || Array.isArray(c[key])))
    throw new Error(`${key} 必须是对象`);
  const defaultAgent = c.defaultAgent ?? 'claude';
  for (const name of new Set([...names, ...Object.keys(record(c.agents))])) {
    if (!validAgentName(name)) throw new Error(`agent 名称无效：${name}`);
    const value = record(c.agents)[name];
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new Error(`agents.${name} 必须是对象`);
    const a = record(record(c.agents)[name]);
    const command = a.command ?? name, extraArgs = a.extraArgs ?? [];
    if (typeof command !== 'string' || !command.trim() || !Array.isArray(extraArgs) || extraArgs.some(x => typeof x !== 'string'))
      throw new Error(`agents.${name} 配置无效`);
    agents[name] = { command, extraArgs };
    if (!isAgent(name)) {
      if (a.type !== 'text' || !Array.isArray(a.args ?? []) || (a.args as unknown[] | undefined)?.some(x => typeof x !== 'string'))
        throw new Error(`agents.${name} 需要 type: text 和字符串数组 args`);
      agents[name].type = 'text'; agents[name].args = (a.args ?? []) as string[];
    } else if (a.type !== undefined || a.args !== undefined) throw new Error(`内置 ${name} 请使用 extraArgs`);
  }
  for (const [name, path] of Object.entries(record(c.projects))) {
    if (typeof path !== 'string') throw new Error(`projects.${name} 必须是路径`);
    projects[name] = directory(path);
  }
  const turnTimeoutMinutes = c.turnTimeoutMinutes ?? 60, mobilePreamble = c.mobilePreamble ?? true;
  if (typeof turnTimeoutMinutes !== 'number' || !Number.isFinite(turnTimeoutMinutes) || turnTimeoutMinutes <= 0 || turnTimeoutMinutes * 60_000 > 2_147_483_647)
    throw new Error('turnTimeoutMinutes 必须是有效的正数（最多 35791 分钟）');
  if (typeof mobilePreamble !== 'boolean') throw new Error('mobilePreamble 必须是布尔值');
  if (!validAgentName(defaultAgent) || !Object.hasOwn(agents, defaultAgent)) throw new Error('defaultAgent 必须是已配置的 agent');
  return { defaultAgent, projects, agents, turnTimeoutMinutes, mobilePreamble };
}
