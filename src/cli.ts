#!/usr/bin/env node
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, directory, loadConfig, VERSION } from './config.ts';
import { record } from './values.ts';
import { acquireLock, initialState, Store } from './store.ts';
import { readJson, writeJson } from './json.ts';
import type { Auth } from './store.ts';
import { trustedBase } from './wechat/ilink.ts';
import { login } from './wechat/login.ts';
import { Bot } from './bot.ts';
import { service } from './service.ts';
import { cleanMedia, doctor } from './maintenance.ts';
import { startLogRotation } from './logs.ts';

async function main(): Promise<void> {
  const [action, ...args] = process.argv.slice(2);
  if (action === '--version') { console.log(VERSION); return; }
  if (!action || action === '--help' || action === '-h') {
    console.log('wcode login          扫码登录\nwcode start          启动 coding bot\nwcode start --echo   协议验证：只回声，不运行 agent\nwcode doctor         本地诊断（只读）\nwcode clean [--days N] [--apply]  媒体清理（默认预览，30 天）\nwcode service install|status|uninstall  macOS 后台服务\n数据目录：~/.wcode（可用 WCODE_HOME 覆盖）'); return;
  }
  if (action === 'doctor' && !args.length) {
    const checks = doctor(dataDir());
    console.log(checks.map(check => `[${check.level}] ${check.name}：${check.detail}`).join('\n'));
    if (checks.some(check => check.level === 'ERROR')) process.exitCode = 1;
    return;
  }
  if (action === 'clean') {
    let days = 30, apply = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--apply' && !apply) apply = true;
      else if (args[i] === '--days' && /^\d+$/.test(args[i + 1] ?? '')) days = Number(args[++i]);
      else throw new Error('用法：wcode clean [--days 正整数] [--apply]');
    }
    console.log(cleanMedia(dataDir(), { days, apply })); return;
  }
  if (action === 'service' && args.length === 1) { service(args[0], dataDir(), fileURLToPath(import.meta.url)); return; }
  if (!['login', 'start'].includes(action) || (args.length && !(action === 'start' && args.length === 1 && args[0] === '--echo')))
    throw new Error('用法：wcode login | start [--echo] | doctor | clean [--days N] [--apply] | service install|status|uninstall');
  if (process.platform === 'win32') throw new Error('当前版本需要 macOS/Linux 的 POSIX 进程组');
  const home = dataDir(), release = acquireLock(home), controller = new AbortController();
  let stopRotation: (() => void) | undefined;
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const config = loadConfig(home), authPath = join(home, 'auth.json');
    const defaults = initialState(config.defaultAgent, config.projects[0]?.path ?? directory(process.cwd()));
    if (action === 'login') {
      const old = record(readJson(authPath, {})), auth = await login(controller.signal);
      const store = new Store(home, defaults);
      if (old.ownerId !== auth.ownerId || old.botId !== auth.botId) store.state = defaults;
      store.state.contextToken = ''; store.save();
      writeJson(authPath, auth); console.log('登录成功。请先停止使用同一 bot 的 OpenClaw gateway，再运行 wcode start。');
    } else {
      stopRotation = startLogRotation(home);
      const value = record(readJson(authPath, {}));
      if (['token', 'baseUrl', 'botId', 'ownerId'].some(k => typeof value[k] !== 'string' || !value[k])) throw new Error('请先运行 wcode login');
      const auth = value as Auth; trustedBase(auth.baseUrl);
      const store = new Store(home, defaults);
      try { store.state.cwd = directory(store.state.cwd); }
      catch { console.error(`当前目录不可用：${store.state.cwd}，请用 /cd 切换。`); }
      const bot = new Bot(store, config, auth);
      if (args[0] === '--echo') bot.execute = async (_spec, o) => o.prompt;
      console.log(`wcode ${VERSION} 已启动${args[0] === '--echo' ? '（回声模式）' : ''}，Ctrl-C 退出。`);
      await bot.start(controller.signal);
    }
  } catch (e) { if (!controller.signal.aborted) throw e; }
  finally { stopRotation?.(); process.off('SIGINT', stop); process.off('SIGTERM', stop); release(); }
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
