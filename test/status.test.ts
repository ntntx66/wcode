import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Bot } from '../src/bot.ts';
import { command, isCommand } from '../src/commands.ts';
import { initialState, Store } from '../src/store.ts';
import { writeJson } from '../src/json.ts';
import { auth, channel, eventually, message, setup, untilAbort } from './helpers.ts';

test('status displays system local time with an offset across date and daylight-saving boundaries', t => {
  const { home, store } = setup(t);
  store.state.task = { status: 'succeeded', agent: 'claude', cwd: home, inputs: [],
    started: Date.UTC(2026, 0, 1, 19, 4, 5), ended: Date.UTC(2026, 6, 1, 19, 5, 6) };
  store.save();
  const module = (name: string) => new URL(`../src/${name}.ts`, import.meta.url).href;
  for (const [timezone, started, ended] of [
    ['Asia/Shanghai', '2026-01-02 03:04:05 GMT+08:00', '2026-07-02 03:05:06 GMT+08:00'],
    ['America/New_York', '2026-01-01 14:04:05 GMT\u221205:00', '2026-07-01 15:05:06 GMT\u221204:00'],
    ['UTC', '2026-01-01 19:04:05 GMT', '2026-07-01 19:05:06 GMT'],
  ]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { command } from ${JSON.stringify(module('commands'))};
      import { Store, initialState } from ${JSON.stringify(module('store'))};
      import { loadConfig } from ${JSON.stringify(module('config'))};
      const home = process.argv[1];
      command('/status', { store: new Store(home, initialState('claude', home)), config: loadConfig(home),
        replies: { send: text => console.log(text) }, queuedCount: 0, stopTask() {} });
    `, home], { env: { ...process.env, TZ: timezone }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(child.stdout.includes(`开始：${started}`), child.stdout);
    assert.ok(child.stdout.includes(`结束：${ended}`), child.stdout);
  }
  assert.equal(new Store(home, initialState('pi', home)).state.task?.started, store.state.task.started);
  assert.equal(new Store(home, initialState('pi', home)).state.task?.ended, store.state.task.ended);
});

test('status reports running, merged queue and the last execution without task history or results', async t => {
  const { home, store, config } = setup(t), sent: string[] = [], finish: ((text: string) => void)[] = [];
  const bot = new Bot(store, config, auth, channel(sent), async () => new Promise(resolve => finish.push(resolve)));
  bot.accept({ get_updates_buf: '1', msgs: [message('first'), message('second'), message('third'), message('/status')] });
  const disk = new Store(home, initialState('pi', home)).state;
  assert.equal(disk.task?.status, 'running'); assert.equal(disk.task?.inputs[0].text, 'first');
  assert.deepEqual(disk.pendingInputs.map(input => input.text), ['second', 'third']);
  assert.ok(store.state.outbox.some(item => item.text.includes('状态：运行中') && item.text.includes('排队：2')));
  finish[0]('first result'); await eventually(() => finish.length === 2);
  assert.deepEqual(store.state.task?.inputs.map(input => input.text), ['second', 'third']);
  finish[1]('second result'); await eventually(() => !bot.active && !bot.replies.pending);
  const restored = new Store(home, initialState('pi', home));
  assert.equal(restored.state.task?.status, 'succeeded'); assert.ok(restored.state.task?.started && restored.state.task.ended);
  assert.deepEqual(restored.state.pendingInputs, []);
  const stateText = readFileSync(restored.path, 'utf8');
  for (const removed of ['"tasks"', '"nextTaskId"', '"retryOf"', '"outputs"', 'first result', 'second result']) assert.ok(!stateText.includes(removed));
  assert.ok(sent.includes('first result')); assert.ok(sent.includes('second result')); assert.ok(!sent.some(text => /任务 #\d+/.test(text)));
  const reader = new Bot(restored, config, auth, channel(sent), async () => assert.fail('status must not run an agent'));
  reader.accept({ get_updates_buf: '2', msgs: [message('/状态')] }); await eventually(() => !reader.replies.pending);
  assert.ok(sent.at(-1)?.includes('最近执行：完成')); assert.ok(sent.at(-1)?.includes('second / third'));
});

test('removed commands and aliases have no dispatcher or help entry', async t => {
  const { store, config } = setup(t), sent: string[] = [], bot = new Bot(store, config, auth, channel(sent));
  for (const text of ['/tasks', '/tasks #1', '/任务', '/result', '/结果', '/retry 1', '/重试']) {
    assert.equal(isCommand(text), false); assert.equal(command(text, bot), false);
  }
  command('/help', bot); store.state.contextToken = 'context'; bot.replies.resume();
  await eventually(() => !bot.replies.pending);
  for (const text of ['/tasks', '/任务', '/result', '/结果', '/retry', '/重试']) assert.ok(!sent.join('\n').includes(text));
});

test('a real process crash preserves active and queued inputs; status reports interruption without replay', async t => {
  const { home, store, config } = setup(t); store.save();
  const module = (name: string) => new URL(`../src/${name}.ts`, import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Bot } from ${JSON.stringify(module('bot'))};
    import { Store, initialState } from ${JSON.stringify(module('store'))};
    import { loadConfig } from ${JSON.stringify(module('config'))};
    const home = process.argv[1], store = new Store(home, initialState('claude', home));
    const api = { send: async () => {}, typing: async (_token, signal) => new Promise(resolve => signal.addEventListener('abort', resolve)), updates: async () => ({}) };
    const bot = new Bot(store, loadConfig(home), ${JSON.stringify(auth)}, api, async (_spec, options) => {
      options.onEvent({type:'session', id:'before-crash'}); return new Promise(() => {});
    });
    const message = text => ({message_type:1, from_user_id:'owner', context_token:'old', item_list:[{type:1,text_item:{text}}]});
    bot.accept({get_updates_buf:'committed', msgs:[message('original'), message('queued')]});
    process.exit(23);
  `, home], { encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr);
  const restored = new Store(home, initialState('pi', home)), calls: { prompt: string; sessionId?: string }[] = [], sent: string[] = [];
  const bot = new Bot(restored, config, auth, channel(sent), async (_spec, options) => { calls.push(options); return 'continued'; }, () => {});
  assert.equal(calls.length, 0); assert.equal(restored.state.cursor, 'committed');
  assert.equal(restored.state.task?.status, 'interrupted');
  assert.equal(restored.state.task?.inputs[0].text, 'original'); assert.equal(restored.state.task?.queuedInputs?.[0].text, 'queued');
  assert.deepEqual(restored.state.pendingInputs, []);
  bot.accept({ get_updates_buf: 'next', msgs: [message('/status')] }); await eventually(() => !bot.replies.pending);
  assert.equal(calls.length, 0); assert.ok(sent.some(text => text.includes('未自动重跑')));
  assert.ok(sent.at(-1)?.includes('中断，待核查')); assert.ok(sent.at(-1)?.includes('未执行 1 条：queued'));
  const saved = new Store(home, initialState('pi', home));
  new Bot(saved, config, auth, channel(), async () => assert.fail('second restart must not execute'));
  assert.equal(saved.state.outbox.length, 0); assert.equal(saved.state.task?.queuedInputs?.length, 1);
  bot.accept({ get_updates_buf: 'continue', msgs: [message('check existing changes and continue')] });
  await bot.active?.done; await eventually(() => !bot.replies.pending);
  assert.equal(calls.length, 1); assert.equal(calls[0].prompt, 'check existing changes and continue'); assert.equal(calls[0].sessionId, 'before-crash');
  assert.equal(restored.state.task?.status, 'succeeded'); assert.equal(restored.state.task?.queuedInputs, undefined);
});

test('cursor commit journals inputs even when command dispatch persistence fails', t => {
  const { home, store, config } = setup(t); let runs = 0;
  const bot = new Bot(store, config, auth, channel(), async () => { runs++; return 'done'; });
  const save = store.save.bind(store); let writes = 0;
  store.save = () => { if (++writes > 1) throw new Error('disk full'); save(); };
  assert.throws(() => bot.accept({ get_updates_buf: 'saved', msgs: [message('/status'), message('do work')] }), /disk full/);
  assert.equal(runs, 0);
  const restored = new Store(home, initialState('claude', home));
  assert.equal(restored.state.cursor, 'saved'); assert.equal(restored.state.pendingInputs[0].text, 'do work');
  new Bot(restored, config, auth, channel(), async () => assert.fail('restart must not execute'), () => {});
  assert.equal(restored.state.task?.status, 'interrupted'); assert.equal(restored.state.task?.queuedInputs?.[0].text, 'do work');
});

test('stop clears queued inputs, preserves messages after stop and timeout reports failure', async t => {
  const { store, config } = setup(t), calls: string[] = [];
  const bot = new Bot(store, config, auth, channel(), async (_spec, options) => {
    calls.push(options.prompt); await untilAbort(options.signal); options.signal.throwIfAborted(); return '';
  });
  bot.accept({ get_updates_buf: '1', msgs: [message('run'), message('queued')] });
  bot.accept({ get_updates_buf: '2', msgs: [message('queued too'), message('/stop'), message('after stop')] });
  assert.equal(bot.queuedCount, 1);
  assert.deepEqual(store.state.pendingInputs.map(input => input.text), ['after stop']);
  await eventually(() => calls.length === 2); assert.deepEqual(calls, ['run', 'after stop']);
  bot.accept({ get_updates_buf: '3', msgs: [message('/stop')] }); await bot.active?.done;
  assert.equal(store.state.task?.status, 'stopped'); assert.deepEqual(store.state.pendingInputs, []);
  assert.equal(bot.queuedCount, 0);
  config.turnTimeoutMinutes = 0.0002;
  bot.accept({ get_updates_buf: '4', msgs: [message('timeout')] }); await bot.active?.done;
  assert.equal(store.state.task?.status, 'failed'); await eventually(() => !bot.replies.pending);
});

test('old state keeps cursor, sessions and outbox while collapsing history and preserving pending work', t => {
  const { home, store, config } = setup(t), input = (text: string) => ({ text, attachments: [] });
  const base = { ...store.state, cursor: 'cursor', sessions: { 'claude:/old': 'session' }, outbox: [{ id: 'reply', text: 'unsent' }] };
  const { pendingInputs: _pendingInputs, ...old } = base;
  writeJson(store.path, old);
  assert.deepEqual(new Store(home, initialState('pi', home)).state.pendingInputs, []);
  const legacyTask = { id: 1, agent: 'claude', cwd: home, model: 'model', created: Date.now(), inputs: [input('done')], files: [], outputs: [], result: 'old result' };
  writeJson(store.path, { ...base, tasks: [
    { ...legacyTask, status: 'succeeded' },
    { ...legacyTask, id: 2, status: 'running', inputs: [input('active')], started: Date.now() },
    { ...legacyTask, id: 3, status: 'queued', inputs: [input('queued')] },
  ], nextTaskId: 4, pendingInputs: [input('undispatched')] });
  const restored = new Store(home, initialState('pi', home));
  assert.equal(restored.state.cursor, 'cursor'); assert.equal(restored.state.sessions['claude:/old'], 'session');
  assert.equal(restored.state.outbox[0].text, 'unsent'); assert.equal(restored.state.task?.inputs[0].text, 'active');
  new Bot(restored, config, auth, channel(), async () => assert.fail('migration must not execute'), () => {});
  assert.equal(restored.state.task?.status, 'interrupted');
  assert.deepEqual(restored.state.task?.queuedInputs?.map(input => input.text), ['queued', 'undispatched']);
  const disk = readFileSync(store.path, 'utf8');
  for (const removed of ['"tasks"', '"nextTaskId"', 'old result', '"outputs"', '"files"', '"model"']) assert.ok(!disk.includes(removed));
  for (const broken of [null, {}, { ...restored.state.task, status: 'unexpected' }, { ...restored.state.task, inputs: [null] }]) {
    writeJson(store.path, { ...base, task: broken }); assert.throws(() => new Store(home, initialState('pi', home)), /格式无效/);
  }
});
