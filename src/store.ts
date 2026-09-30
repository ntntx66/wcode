import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isAgent, record } from './config.ts';
import type { AgentName } from './config.ts';

export type Auth = { token: string; baseUrl: string; botId: string; ownerId: string };
export type State = {
  cursor: string; contextToken: string; agent: AgentName; cwd: string;
  models: Partial<Record<AgentName, string>>; sessions: Record<string, string>;
  outbox: { id: string; text: string }[]; pages: string[];
};
export const initialState = (agent: AgentName, cwd: string): State =>
  ({ cursor: '', contextToken: '', agent, cwd, models: {}, sessions: {}, outbox: [], pages: [] });
export const sessionKey = (state: Pick<State, 'agent' | 'cwd'>) => `${state.agent}:${state.cwd}`;
export function readJson(path: string, fallback: unknown): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw new Error(`无法读取 ${path}`, { cause: e }); }
}
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  } finally { try { unlinkSync(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
}
export class Store {
  state: State;
  path: string;
  constructor(home: string, defaults: State) {
    this.path = join(home, 'state.json');
    const s = record(readJson(this.path, defaults));
    if (!isAgent(s.agent) || typeof s.cwd !== 'string' || !s.cwd.startsWith('/') ||
      typeof s.cursor !== 'string' || typeof s.contextToken !== 'string' ||
      !s.models || typeof s.models !== 'object' || Array.isArray(s.models) ||
      !s.sessions || typeof s.sessions !== 'object' || Array.isArray(s.sessions) || !Array.isArray(s.outbox) ||
      Object.values(record(s.models)).some(x => typeof x !== 'string') ||
      Object.values(record(s.sessions)).some(x => typeof x !== 'string') ||
      s.outbox.some(x => typeof x?.id !== 'string' || typeof x?.text !== 'string') ||
      (s.pages !== undefined && (!Array.isArray(s.pages) || s.pages.some(x => typeof x !== 'string'))))
      throw new Error('state.json 格式无效；请备份后修复，不能安全地重置游标');
    this.state = { ...s, pages: s.pages ?? [] } as State;
  }
  save(): void { writeJson(this.path, this.state); }
}
export function acquireLock(home: string): () => void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, 'wcode.lock'), guard = `${path}.reclaim`;
  const owner = { pid: process.pid, nonce: randomUUID() };
  const create = () => { const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify(owner)); } finally { closeSync(fd); } };
  try { create(); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // Serialize stale-lock reclamation, so two starters cannot unlink a new live lock.
    let fd: number;
    try { fd = openSync(guard, 'wx', 0o600); } catch { throw new Error(`锁正在恢复；若没有 wcode 进程，请检查 ${guard}`); }
    try {
      const old = record(readJson(path, {}));
      if (!Number.isInteger(old.pid) || Number(old.pid) <= 0) throw new Error(`锁损坏，请确认没有 wcode 进程后移除 ${path}`);
      try { process.kill(Number(old.pid), 0); throw new Error(`wcode 已在运行（pid ${old.pid}）`); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err; }
      unlinkSync(path); create();
    } finally { closeSync(fd); unlinkSync(guard); }
  }
  return () => { if (record(readJson(path, {})).nonce === owner.nonce) unlinkSync(path); };
}
