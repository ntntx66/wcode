// Run the installed JavaScript, with recorded CLI output and an in-memory channel.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Bot as BotType, Channel } from '../src/bot.ts';
import type { run as RunType } from '../src/agents/run.ts';
import type { Store as StoreType, initialState as InitialStateType } from '../src/store.ts';
import type { loadConfig as LoadConfigType } from '../src/config.ts';

export async function verifyInstalled(packageDir: string): Promise<void> {
  const load = (name: string) => import(pathToFileURL(join(packageDir, 'dist', name)).href);
  const { Bot } = await load('bot.js') as { Bot: typeof BotType };
  const { run } = await load('agents/run.js') as { run: typeof RunType };
  const { Store, initialState } = await load('store.js') as { Store: typeof StoreType; initialState: typeof InitialStateType };
  const { loadConfig, VERSION } = await load('config.js') as { loadConfig: typeof LoadConfigType; VERSION: string };
  const expectedVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(VERSION, expectedVersion);
  const cli = spawnSync(process.execPath, [join(packageDir, 'dist', 'cli.js'), '--version'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), expectedVersion);

  for (const name of ['claude', 'codex', 'pi']) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'wcode-installed-')));
    const fixture = readFileSync(new URL(`../test/fixtures/${name}-progress.jsonl`, import.meta.url), 'utf8');
    const sent: string[] = [];
    const store = new Store(home, initialState(name, home));
    const api: Channel = { send: async text => { sent.push(text); }, typing: async () => {}, updates: async () => ({}) };
    const auth = { token: 'test', baseUrl: 'https://example.invalid', botId: 'test', ownerId: 'owner' };
    const bot = new Bot(store, loadConfig(home), auth, api, (spec, options) => run({
      ...spec, command: process.execPath,
      args: () => ['-e', `process.stdin.resume(); process.stdout.write(${JSON.stringify(fixture)});`],
    }, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) }));
    try {
      for (let round = 1; round <= 2; round++) {
        sent.length = 0;
        bot.accept({ get_updates_buf: String(round), msgs: [{ message_type: 1, from_user_id: 'owner',
          context_token: 'local', item_list: [{ type: 1, text_item: { text: 'verify' } }] }] });
        await bot.active?.done;
        await bot.replies.pending;
        assert.equal(bot.failure, undefined);
        assert.equal(store.state.task?.status, 'succeeded');
        assert.equal(sent.length, 3);
        assert.equal(sent.at(-1), 'FINAL: 两个命令都已完成。');
        assert.equal(store.state.outbox.length, 0);
        assert.equal(new Store(home, initialState(name, home)).state.task?.status, 'succeeded');
      }
      console.log(`${process.version} installed ${name}: replay and persistence OK`);
    } finally {
      bot.controller.abort();
      await bot.active?.done;
      await bot.replies.pending;
      rmSync(home, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('用法：node scripts/verify-installed.ts /安装目录/lib/node_modules/wcode');
  await verifyInstalled(resolve(process.argv[2]));
}
