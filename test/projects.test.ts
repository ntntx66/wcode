import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Bot } from '../src/bot.ts';
import { command } from '../src/commands.ts';
import { directory, loadConfig } from '../src/config.ts';
import { initialState, Store } from '../src/store.ts';
import { writeJson } from '../src/json.ts';
import { auth, channel, eventually, message, setup, untilAbort } from './helpers.ts';

test('cd adds real paths once and removals persist without changing the current directory or sessions', t => {
  const { home, store } = setup(t), original = { projects: { work: home }, mobilePreamble: false };
  writeJson(join(home, 'config.json'), original);
  const config = loadConfig(home), bot = new Bot(store, config, auth, channel());
  const project = join(home, 'folder with spaces'), link = join(home, 'shortcut');
  mkdirSync(project); symlinkSync(project, link);
  const file = join(project, 'keep.txt'); writeFileSync(file, 'keep');
  const disk = () => new Store(home, initialState('pi', home));
  command(`/cd ${project}`, bot);
  command(`/cd ${link}/`, bot);
  assert.equal(disk().state.cwd, project);
  assert.deepEqual(disk().state.projects, [{ name: 'work', path: home }, { name: 'folder with spaces', path: project }]);
  store.state.sessions[`claude:${project}`] = 'keep-session';
  store.state.pages = ['unread']; store.save();
  command('/cd rm folder with spaces', bot);
  assert.equal(store.state.cwd, project);
  assert.deepEqual(store.state.pages, ['unread']);
  assert.equal(store.state.sessions[`claude:${project}`], 'keep-session');
  assert.equal(readFileSync(file, 'utf8'), 'keep');
  const restored = disk(), reader = new Bot(restored, loadConfig(home), auth, channel());
  assert.deepEqual(restored.state.projects, [{ name: 'work', path: home }]);
  command('/cd rm 1', reader);
  assert.deepEqual(disk().state.projects, []);
  const empty = disk(); new Bot(empty, loadConfig(home), auth, channel());
  assert.deepEqual(empty.state.projects, []);
  assert.equal(empty.state.cwd, project);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), original);
});

test('cd removal requires a unique name or global index and can remove unavailable projects', t => {
  const { home, store, config } = setup(t);
  config.projects = ['one/shared', 'two/shared', 'rm', '2'].map(path => ({ name: basename(path), path: join(home, path) }));
  const bot = new Bot(store, config, auth, channel());
  store.state.pages = ['keep']; store.save();
  command('/cd rm shared', bot);
  assert.equal(store.state.projects?.length, 4);
  assert.deepEqual(store.state.pages, ['keep']);
  const reply = store.state.outbox.at(-1)!.text;
  assert.match(reply, /\/cd rm 序号/);
  assert.ok(reply.includes(`2. shared：${join(home, 'two/shared')}`));
  command('/cd rm 2', bot);
  assert.equal(store.state.projects?.length, 3);
  assert.equal(store.state.projects?.[0].path, join(home, 'one/shared'));
  assert.equal(store.state.cwd, home);
  command('/cd rm 2', bot);
  assert.deepEqual(store.state.projects?.map(project => project.name), ['shared', '2']);
  for (const text of ['/cd rm', '/cd rm unknown', '/cd rm 0', '/cd rm 99']) command(text, bot);
  assert.deepEqual(store.state.projects?.map(project => project.name), ['shared', '2']);
  assert.deepEqual(store.state.pages, ['keep']);
});

test('cd rejects invalid paths and treats absolute and home paths as paths', t => {
  const { home, store, config } = setup(t), project = join(home, 'project');
  mkdirSync(project);
  config.projects = [{ name: project, path: home }];
  const bot = new Bot(store, config, auth, channel());
  command(`/cd ${project}`, bot);
  assert.equal(store.state.cwd, project);
  assert.equal(store.state.projects?.length, 2);
  command('/cd ~/', bot);
  assert.equal(store.state.cwd, directory(homedir()));
  const before = structuredClone(store.state.projects);
  for (const path of [join(home, 'missing'), join(home, 'state.json'), 'relative', '99']) command(`/cd ${path}`, bot);
  assert.equal(store.state.cwd, directory(homedir()));
  assert.deepEqual(store.state.projects, before);
});

test('failed cd commits roll back additions, removals and pagination before later work runs', async t => {
  const { home, store, config } = setup(t), project = join(home, 'project'), calls: string[] = [], sent: string[] = [];
  mkdirSync(project);
  const bot = new Bot(store, config, auth, channel(sent), async (_spec, options) => { calls.push(options.cwd); return 'done'; });
  store.state.pages = ['keep']; store.save();
  const save = store.save.bind(store); let injected = false;
  store.save = () => {
    if (store.state.cwd === project && !injected) { injected = true; throw new Error('transient write error'); }
    save();
  };
  command(`/cd ${project}`, bot);
  assert.equal(store.state.cwd, home);
  assert.deepEqual(store.state.projects, []);
  assert.deepEqual(store.state.pages, ['keep']);
  assert.equal(new Store(home, initialState('pi', home)).state.cwd, home);
  bot.accept({ get_updates_buf: '1', msgs: [message('work')] });
  await bot.active?.done; await eventually(() => !bot.replies.pending);
  assert.deepEqual(calls, [home]);
  assert.ok(sent.some(text => text.includes('transient write error')));
  store.save = save;
  command(`/cd ${project}`, bot);
  store.state.pages = ['keep again']; store.save();
  const before = structuredClone(store.state.projects); injected = false;
  store.save = () => {
    if (!store.state.projects?.length && !injected) { injected = true; throw new Error('removal write error'); }
    save();
  };
  command('/cd rm 1', bot);
  assert.deepEqual(store.state.projects, before);
  assert.deepEqual(new Store(home, initialState('pi', home)).state.projects, before);
  assert.equal(store.state.cwd, project);
  assert.deepEqual(store.state.pages, ['keep again']);
  await eventually(() => !bot.replies.pending);
});

test('cd only allows listing while running or stopping', async t => {
  const { home, store, config } = setup(t), project = join(home, 'project'); mkdirSync(project);
  config.projects = [{ name: 'work', path: home }];
  const sent: string[] = [], bot = new Bot(store, config, auth, channel(sent), async (_spec, options) => {
    await untilAbort(options.signal); options.signal.throwIfAborted(); return '';
  }, () => {});
  bot.accept({ get_updates_buf: '1', msgs: [message('run')] });
  command('/cd', bot);
  command(`/cd ${project}`, bot);
  command('/cd rm work', bot);
  assert.equal(store.state.cwd, home);
  assert.deepEqual(store.state.projects, config.projects);
  command('/stop', bot);
  command('/cd rm 1', bot);
  assert.deepEqual(store.state.projects, config.projects);
  await bot.active?.done; await eventually(() => !bot.replies.pending);
  assert.ok(sent.some(text => text.includes('当前目录：') && text.includes('1. work')));
  assert.equal(sent.filter(text => text.includes('任务正在运行')).length, 3);
});

test('long cd lists and ambiguity replies preserve unread task pages using real Replies', async t => {
  const { home, store, config } = setup(t);
  config.projects = Array.from({ length: 100 }, (_, i) => ({ name: 'shared', path: join(home, `${i}-${'x'.repeat(80)}`, 'shared') }));
  const bot = new Bot(store, config, auth, channel());
  store.state.pages = ['unread task page']; store.save();
  for (const text of ['/cd', '/cd shared', '/cd rm shared']) {
    const count = store.state.outbox.length;
    command(text, bot);
    assert.ok(store.state.outbox.length - count > 3);
    assert.deepEqual(store.state.pages, ['unread task page']);
    assert.deepEqual(new Store(home, initialState('pi', home)).state.pages, ['unread task page']);
  }
  assert.equal(store.state.projects?.length, 100);
  assert.equal(store.state.cwd, home);
  await eventually(() => !bot.replies.pending);
});

test('CLI starts with missing directories, refuses execution there and accepts cd recovery', t => {
  const { home, store } = setup(t), missing = join(home, 'missing'), project = join(home, 'usable');
  mkdirSync(project);
  writeJson(join(home, 'config.json'), { projects: [missing] });
  writeJson(join(home, 'auth.json'), auth);
  store.state.cwd = missing; store.save();
  const module = (name: string) => new URL(`../src/${name}.ts`, import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Ilink } from ${JSON.stringify(new URL('../src/wechat/ilink.ts', import.meta.url).href)};
    import { Store, initialState } from ${JSON.stringify(module('store'))};
    import { setTimeout as sleep } from 'node:timers/promises';
    const [home, project] = process.argv.slice(1);
    const batches = [['rejected request'], ['/cd rm 1', '/cd ' + project, 'usable request']];
    let cursor = 0;
    Ilink.prototype.updates = async function (_cursor, signal) {
      while (new Store(home, initialState('claude', home)).state.task?.status === 'running') await sleep(5);
      const batch = batches.shift();
      if (!batch) { await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, {once:true})); return {}; }
      return { get_updates_buf: String(++cursor), msgs: batch.map(text => (${message.toString()})(text)) };
    };
    Ilink.prototype.typing = async function (_token, signal) {
      await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, {once:true}));
    };
    Ilink.prototype.send = async function (text) {
      console.log(text);
      if (text === 'usable request') process.kill(process.pid, 'SIGTERM');
    };
    process.argv = [process.execPath, 'wcode', 'start', '--echo'];
    await import(${JSON.stringify(module('cli'))});
  `, home, project], { env: { ...process.env, WCODE_HOME: home }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /已启动/);
  assert.match(child.stdout, /当前目录不可用/);
  assert.match(child.stdout, /已移除项目/);
  assert.match(child.stdout, /usable request/);
  assert.ok(!child.stdout.includes('rejected request'));
  const restored = new Store(home, initialState('pi', home));
  assert.equal(restored.state.cwd, project);
  assert.deepEqual(restored.state.projects, [{ name: 'usable', path: project }]);
  assert.equal(restored.state.task?.status, 'succeeded');
  assert.ok(existsSync(project));
});

test('persisted project entries are validated without resetting state', t => {
  const { home, store } = setup(t);
  for (const projects of [null, {}, [null], [{ name: 'bad', path: 'relative' }], [{ name: 42, path: home }]]) {
    writeJson(store.path, { ...store.state, projects });
    assert.throws(() => new Store(home, initialState('pi', home)), /格式无效/);
  }
  writeJson(store.path, { ...store.state, projects: [{ name: 'missing', path: join(home, 'missing') }] });
  assert.equal(new Store(home, initialState('pi', home)).state.projects?.length, 1);
});
