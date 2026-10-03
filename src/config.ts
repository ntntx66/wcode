import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { readJson } from './json.ts';
import { record, validAgentName } from './values.ts';

export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const names = ['claude', 'codex', 'pi'] as const;
export type AgentName = string;
export type AgentConfig = { command: string; extraArgs: string[]; type?: 'text'; args?: string[] };
export type Project = { name: string; path: string };
export type Config = {
  defaultAgent: AgentName; projects: Project[];
  agents: Record<AgentName, AgentConfig>; turnTimeoutMinutes: number; mobilePreamble: boolean;
};
export const dataDir = () => resolve(process.env.WCODE_HOME || join(homedir(), '.wcode'));
export const isAgent = (v: unknown): v is typeof names[number] => names.includes(v as typeof names[number]);
function absolutePath(value: string): string {
  const path = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(path)) throw new Error(`不是有效的绝对目录：${value}`);
  return path;
}
export function directory(value: string): string {
  const path = absolutePath(value);
  if (!statSync(path).isDirectory()) throw new Error(`不是有效的绝对目录：${value}`);
  return realpathSync(path);
}
export function loadConfig(home: string): Config {
  const raw = readJson(join(home, 'config.json'), {});
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.json 必须是对象');
  const c = record(raw), agents: Config['agents'] = Object.create(null), projects: Project[] = [];
  if (c.agents !== undefined && (c.agents === null || typeof c.agents !== 'object' || Array.isArray(c.agents)))
    throw new Error('agents 必须是对象');
  if (c.projects !== undefined && (c.projects === null || typeof c.projects !== 'object'))
    throw new Error('projects 必须是路径数组或别名对象');
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
  const entries = Array.isArray(c.projects) ? c.projects.map(path => [undefined, path] as const) : Object.entries(record(c.projects));
  for (const [index, [name, path]] of entries.entries()) {
    if (typeof path !== 'string') throw new Error(`projects.${name ?? index} 必须是路径`);
    let resolved = absolutePath(path);
    try { resolved = directory(resolved); }
    catch (e) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      resolved = resolve(resolved);
    }
    const alias = name ?? (basename(resolved) || resolved);
    if (!projects.some(project => project.name === alias && project.path === resolved)) projects.push({ name: alias, path: resolved });
  }
  const turnTimeoutMinutes = c.turnTimeoutMinutes ?? 60, mobilePreamble = c.mobilePreamble ?? true;
  if (typeof turnTimeoutMinutes !== 'number' || !Number.isFinite(turnTimeoutMinutes) || turnTimeoutMinutes <= 0 || turnTimeoutMinutes * 60_000 > 2_147_483_647)
    throw new Error('turnTimeoutMinutes 必须是有效的正数（最多 35791 分钟）');
  if (typeof mobilePreamble !== 'boolean') throw new Error('mobilePreamble 必须是布尔值');
  if (!validAgentName(defaultAgent) || !Object.hasOwn(agents, defaultAgent)) throw new Error('defaultAgent 必须是已配置的 agent');
  return { defaultAgent, projects, agents, turnTimeoutMinutes, mobilePreamble };
}
