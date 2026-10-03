import { constants, accessSync, lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { directory, loadConfig, VERSION } from './config.ts';
import { record } from './values.ts';
import { acquireLock, initialState, Store, taskStatuses } from './store.ts';
import { readJson } from './json.ts';
import type { State } from './store.ts';
import { trustedBase } from './wechat/ilink.ts';
import { readSnapshot } from './files.ts';
import { serviceStatus } from './service.ts';

export type Check = { level: 'OK' | 'WARN' | 'ERROR'; name: string; detail: string };
type MediaFile = { path: string; size: number; modified: number };
export const bytes = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / (1024 * 1024)).toFixed(1)} MiB`;
function mediaFiles(home: string): MediaFile[] {
  const files: MediaFile[] = [];
  for (const bucket of ['inbound', 'outbound']) {
    const dir = join(home, 'media', bucket);
    try {
      if (!lstatSync(join(home, 'media')).isDirectory() || !lstatSync(dir).isDirectory()) throw new Error('媒体目录不能是符号链接或其他文件类型');
      for (const name of readdirSync(dir)) {
        const path = join(dir, name), stat = lstatSync(path);
        if (stat.isFile()) files.push({ path, size: stat.size, modified: stat.mtimeMs });
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return files;
}
function protectedMedia(state: State): Set<string> {
  const paths = new Set(state.outbox.flatMap(message => message.file ? [resolve(message.file.path)] : []));
  return paths;
}
export function mediaUsage(home: string): { count: number; size: number } {
  const files = mediaFiles(home);
  return { count: files.length, size: files.reduce((sum, file) => sum + file.size, 0) };
}
export function executable(command: string, cwd: string, envPath = process.env.PATH ?? ''): string | undefined {
  const candidates = command.includes('/') ? [resolve(cwd, command)] : envPath.split(':').map(path => resolve(cwd, path, command));
  for (const path of candidates) {
    try {
      const resolved = realpathSync(path);
      accessSync(resolved, constants.X_OK);
      if (lstatSync(resolved).isFile()) return resolved;
    } catch { /* Try the next PATH entry. */ }
  }
}
export function doctor(home: string): Check[] {
  const checks: Check[] = [];
  const add = (level: Check['level'], name: string, detail: string) => checks.push({ level, name, detail });
  const inspect = (name: string, action: () => string) => {
    try { add('OK', name, action()); } catch (e) { add('ERROR', name, String(e instanceof Error ? e.message : e)); }
  };
  const [major, minor] = process.versions.node.split('.').map(Number);
  add(major > 22 || (major === 22 && minor >= 18) ? 'OK' : 'ERROR', 'Node', `${process.version} · wcode ${VERSION}`);
  add(['darwin', 'linux'].includes(process.platform) ? 'OK' : 'ERROR', '平台', process.platform);
  inspect('数据目录', () => {
    let parent = home;
    while (true) {
      try {
        accessSync(parent, constants.R_OK | constants.W_OK | constants.X_OK);
        directory(parent); break;
      }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw e; parent = dirname(parent); }
    }
    return home;
  });
  let config: ReturnType<typeof loadConfig> | undefined, state: State | undefined;
  inspect('配置', () => { config = loadConfig(home); return `${Object.keys(config.agents).length} 个 agent · ${Object.keys(config.projects).length} 个项目`; });
  inspect('状态', () => {
    state = new Store(home, initialState(config?.defaultAgent ?? 'claude', Object.values(config?.projects ?? {})[0] ?? resolve(process.cwd()))).state;
    return `最近执行：${state.task ? taskStatuses[state.task.status] : '无记录'} · 待执行 ${state.pendingInputs.length} · 待补发 ${state.outbox.length}`;
  });
  inspect('登录凭据', () => {
    const value = record(readJson(join(home, 'auth.json'), {}));
    if (['token', 'baseUrl', 'botId', 'ownerId'].some(key => typeof value[key] !== 'string' || !value[key])) throw new Error('缺少有效凭据，请运行 wcode login');
    trustedBase(String(value.baseUrl)); return '本地字段有效';
  });
  for (const name of ['auth.json', 'state.json']) {
    try {
      const mode = lstatSync(join(home, name)).mode & 0o777;
      add(mode & 0o077 ? 'WARN' : 'OK', `${name} 权限`, mode.toString(8));
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') add('ERROR', `${name} 权限`, String(e)); }
  }
  const cwd = state?.cwd ?? Object.values(config?.projects ?? {})[0] ?? resolve(process.cwd());
  inspect('工作目录', () => directory(cwd));
  if (config) {
    const required = state?.agent ?? config.defaultAgent;
    if (!config.agents[required]) add('ERROR', '当前 agent', `${required} 已移出配置`);
    for (const [name, agent] of Object.entries(config.agents)) {
      const path = executable(agent.command, cwd);
      add(path ? 'OK' : name === required ? 'ERROR' : 'WARN', `agent ${name}`, path ?? `找不到可执行命令：${agent.command}`);
    }
  }
  inspect('待补发文件', () => {
    const files = state?.outbox.flatMap(message => message.file ? [message.file] : []) ?? [];
    for (const file of files) readSnapshot(file);
    return `${files.length} 个快照校验通过`;
  });
  inspect('媒体占用', () => { const usage = mediaUsage(home); return `${usage.count} 个文件 · ${bytes(usage.size)}`; });
  inspect('日志占用', () => {
    let size = 0;
    try {
      for (const name of readdirSync(join(home, 'logs'))) {
        const stat = lstatSync(join(home, 'logs', name)); if (stat.isFile()) size += stat.size;
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return bytes(size);
  });
  if (process.platform === 'darwin') {
    try {
      const status = serviceStatus(home);
      add(status.loaded && !status.pid ? 'WARN' : 'OK', '后台服务', status.loaded ?
        `已加载${status.pid ? `（pid ${status.pid}）` : '，当前无进程'}${status.exitCode === undefined ? '' : ` · 上次退出码 ${status.exitCode}`}` : '未加载，可前台运行');
    } catch (e) { add('ERROR', '后台服务', String(e instanceof Error ? e.message : e)); }
  }
  try {
    const value = readJson(join(home, 'wcode.lock'), null), lock = record(value);
    if (value !== null) {
      if (!Number.isSafeInteger(lock.pid) || Number(lock.pid) <= 0) throw new Error('锁文件 PID 无效');
      try { process.kill(Number(lock.pid), 0); add('OK', '进程', `正在运行（pid ${lock.pid}）`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; add('WARN', '进程', '陈旧锁，下次启动会恢复'); }
    } else add('OK', '进程', '未运行');
  } catch (e) { add('ERROR', '进程', String(e instanceof Error ? e.message : e)); }
  return checks;
}

export function cleanMedia(home: string, options: { apply?: boolean; days?: number } = {}): string {
  const days = options.days ?? 30;
  if (!Number.isSafeInteger(days) || days < 1) throw new Error('--days 须为正整数');
  const release = options.apply ? acquireLock(home) : undefined;
  try {
    const store = new Store(home, initialState('claude', resolve(process.cwd()))), state = store.state, protectedPaths = protectedMedia(state);
    const files = mediaFiles(home), cutoff = Date.now() - days * 86_400_000;
    try { lstatSync(store.path); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || files.length) throw new Error('缺少 state.json，无法确认媒体引用，拒绝清理'); }
    // Agent-owned histories can reference any inbound path; wcode does not inspect them.
    const hasSessions = Object.keys(state.sessions).length > 0;
    const hasPending = state.pendingInputs.length > 0 || state.task?.status === 'running' || state.task?.status === 'interrupted';
    const candidates = files.filter(file => file.modified < cutoff && !protectedPaths.has(resolve(file.path)) && !hasPending &&
      !(hasSessions && dirname(file.path) === join(home, 'media', 'inbound')));
    const size = candidates.reduce((sum, file) => sum + file.size, 0);
    if (options.apply) for (const file of candidates) unlinkSync(file.path);
    return [
      `媒体：${files.length} 个文件 · ${bytes(files.reduce((sum, file) => sum + file.size, 0))}`,
      `${options.apply ? '已清理' : '预览'}：${candidates.length} 个超过 ${days} 天且未被引用的文件 · ${bytes(size)}`,
      ...(hasSessions ? ['会话仍存在，全部入站附件受保护。'] : []),
      ...(hasPending ? ['存在未完成输入，全部媒体受保护。'] : []),
      ...(!options.apply ? [...candidates.map(file => file.path), `执行清理：wcode clean --days ${days} --apply（须先停止 wcode）`] : []),
    ].join('\n');
  } finally { release?.(); }
}
