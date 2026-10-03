import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validAgentName, record } from './values.ts';
import { readJson, writeJson } from './json.ts';
import type { AgentName } from './config.ts';
import type { LocalFile } from './files.ts';
import type { FileItem } from './wechat/media.ts';
import type { Inbound } from './wechat/inbound.ts';

export type Auth = { token: string; baseUrl: string; botId: string; ownerId: string };
export type TaskInput = Pick<Inbound, 'text' | 'attachments'>;
export const taskStatuses = {
  running: '运行中', succeeded: '完成', failed: '失败', stopped: '已停止', interrupted: '中断，待核查',
};
export type TaskState = {
  status: keyof typeof taskStatuses; agent: AgentName; cwd: string; inputs: TaskInput[];
  started?: number; ended?: number; queuedInputs?: TaskInput[];
};
export type State = {
  cursor: string; contextToken: string; agent: AgentName; cwd: string;
  models: Partial<Record<AgentName, string>>; sessions: Record<string, string>;
  outbox: { id: string; text: string; file?: LocalFile; item?: FileItem }[]; pages: string[];
  task?: TaskState; pendingInputs: TaskInput[];
};
export const initialState = (agent: AgentName, cwd: string): State =>
  ({ cursor: '', contextToken: '', agent, cwd, models: {}, sessions: {}, outbox: [], pages: [], pendingInputs: [] });
export const sessionKey = (state: Pick<State, 'agent' | 'cwd'>) => `${state.agent}:${state.cwd}`;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const validInput = (value: unknown): boolean => {
  const input = record(value);
  return typeof input.text === 'string' && Array.isArray(input.attachments) && input.attachments.every(value => {
    const attachment = record(value);
    return ['image', 'file'].includes(String(attachment.kind)) && attachment.item !== null &&
      typeof attachment.item === 'object' && !Array.isArray(attachment.item);
  });
};
const validFile = (value: unknown): boolean => {
  const file = record(value);
  return typeof file.path === 'string' && file.path.startsWith('/') && typeof file.name === 'string' &&
    Number.isSafeInteger(file.size) && Number(file.size) >= 0 && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256);
};
function validTask(value: unknown, legacy = false): boolean {
  const task = record(value);
  return typeof task.status === 'string' && (Object.hasOwn(taskStatuses, task.status) || (legacy && task.status === 'queued')) &&
    validAgentName(task.agent) && typeof task.cwd === 'string' && task.cwd.startsWith('/') &&
    (task.started === undefined || positive(task.started)) && (task.ended === undefined || positive(task.ended)) &&
    Array.isArray(task.inputs) && task.inputs.every(validInput) &&
    (task.queuedInputs === undefined || (Array.isArray(task.queuedInputs) && task.queuedInputs.every(validInput)));
}
export class Store {
  state: State;
  path: string; home: string;
  constructor(home: string, defaults: State) {
    this.home = home;
    this.path = join(home, 'state.json');
    const s = record(readJson(this.path, defaults));
    const legacyTasks = s.tasks === undefined ? [] : s.tasks, pendingInputs = s.pendingInputs === undefined ? [] : s.pendingInputs;
    if (!validAgentName(s.agent) || typeof s.cwd !== 'string' || !s.cwd.startsWith('/') ||
      typeof s.cursor !== 'string' || typeof s.contextToken !== 'string' ||
      !s.models || typeof s.models !== 'object' || Array.isArray(s.models) ||
      !s.sessions || typeof s.sessions !== 'object' || Array.isArray(s.sessions) || !Array.isArray(s.outbox) ||
      Object.values(record(s.models)).some(x => typeof x !== 'string') ||
      Object.values(record(s.sessions)).some(x => typeof x !== 'string') ||
      s.outbox.some(x => typeof x?.id !== 'string' || typeof x?.text !== 'string' ||
        (x.file !== undefined && !validFile(x.file)) ||
        (x.item !== undefined && (!x.file || x.item?.type !== 4 || typeof x.item.file_item?.file_name !== 'string' ||
          typeof x.item.file_item?.len !== 'string' || typeof x.item.file_item?.media?.encrypt_query_param !== 'string' ||
          typeof x.item.file_item?.media?.aes_key !== 'string' || x.item.file_item?.media?.encrypt_type !== 1))) ||
      (s.pages !== undefined && (!Array.isArray(s.pages) || s.pages.some(x => typeof x !== 'string'))) ||
      (s.task !== undefined && !validTask(s.task)) || !Array.isArray(legacyTasks) || !legacyTasks.every(task => validTask(task, true)) ||
      !Array.isArray(pendingInputs) || !pendingInputs.every(validInput))
      throw new Error('state.json 格式无效；请备份后修复，不能安全地重置游标');
    const { tasks: _tasks, nextTaskId: _nextTaskId, ...current } = s;
    let task = s.task as TaskState | undefined;
    if (!task) {
      const previous = legacyTasks.find(task => task.status === 'running') ?? legacyTasks.findLast(task => task.status !== 'queued');
      if (previous) task = { status: previous.status, agent: previous.agent, cwd: previous.cwd, inputs: previous.inputs,
        started: previous.started, ended: previous.ended };
    }
    this.state = { ...current, pages: s.pages ?? [], task,
      pendingInputs: [...legacyTasks.filter(task => task.status === 'queued').flatMap(task => task.inputs), ...pendingInputs] } as State;
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
