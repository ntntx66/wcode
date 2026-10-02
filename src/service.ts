import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireLock } from './store.ts';

export const serviceLabel = (home: string) => `io.wcode.bot.${createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12)}`;
export function serviceStatus(home: string): { loaded: boolean; detail: string; pid?: number; exitCode?: number } {
  if (process.platform !== 'darwin') return { loaded: false, detail: 'launchd 只支持 macOS' };
  const label = serviceLabel(home);
  const result = spawnSync('/bin/launchctl', ['print', `gui/${process.getuid!()}/${label}`], { encoding: 'utf8', timeout: 20_000 });
  if (result.error) throw result.error;
  const pid = result.stdout.match(/\bpid = (\d+)/)?.[1], exitCode = result.stdout.match(/last exit code = (-?\d+)/)?.[1];
  return { loaded: result.status === 0, detail: result.status === 0 ? result.stdout.trim() : `服务未加载：${label}`,
    pid: pid === undefined ? undefined : Number(pid), exitCode: exitCode === undefined ? undefined : Number(exitCode) };
}
const xml = (value: string) => value.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!);
export function launchdPlist(home: string, entry: string, cwd: string, path = process.env.PATH ?? '/usr/bin:/bin'): string {
  home = resolve(home);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${serviceLabel(home)}</string>
<key>ProgramArguments</key><array><string>${xml(realpathSync(process.execPath))}</string><string>${xml(resolve(entry))}</string><string>start</string></array>
<key>WorkingDirectory</key><string>${xml(cwd)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string><key>WCODE_HOME</key><string>${xml(home)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>15</integer>
<key>StandardOutPath</key><string>${xml(join(home, 'logs', 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(home, 'logs', 'stderr.log'))}</string>
</dict></plist>
`;
}
export function service(action: string, home: string, entry: string): void {
  if (process.platform !== 'darwin') throw new Error('launchd 服务只支持 macOS；Linux 可使用 tmux 或系统服务');
  home = resolve(home);
  const label = serviceLabel(home), domain = `gui/${process.getuid!()}`, target = `${domain}/${label}`;
  const dir = join(homedir(), 'Library', 'LaunchAgents'), path = join(dir, `${label}.plist`);
  const ctl = (args: string[]) => spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 20_000 });
  const current = serviceStatus(home);
  if (action === 'status') { console.log(current.detail); return; }
  if (action === 'uninstall') {
    if (current.loaded) {
      const result = ctl(['bootout', target]);
      if (result.status !== 0) throw new Error(`launchctl bootout 失败：${result.stderr.trim()}`);
    }
    if (existsSync(path)) unlinkSync(path);
    console.log('launchd 服务已卸载，配置和聊天状态保留。'); return;
  }
  if (action !== 'install') throw new Error('用法：wcode service install|status|uninstall');
  if (current.loaded) throw new Error('服务已加载；更新安装路径或 PATH 前先运行 wcode service uninstall');
  const release = acquireLock(home); release();
  if (!existsSync(join(home, 'auth.json'))) throw new Error('请先运行 wcode login');
  mkdirSync(dir, { recursive: true }); mkdirSync(join(home, 'logs'), { recursive: true, mode: 0o700 });
  for (const name of ['stdout.log', 'stderr.log']) {
    const log = join(home, 'logs', name); writeFileSync(log, '', { flag: 'a', mode: 0o600 }); chmodSync(log, 0o600);
  }
  writeFileSync(path, launchdPlist(home, entry, home), { mode: 0o600 }); chmodSync(path, 0o600);
  const result = ctl(['bootstrap', domain, path]);
  if (result.status !== 0) throw new Error(`launchctl bootstrap 失败，配置保存在 ${path}：${result.stderr.trim()}`);
  console.log(`launchd 服务已加载：${label}\n登录系统后自动启动；日志：${join(home, 'logs')}\n用 wcode service status 查看进程状态。`);
}
