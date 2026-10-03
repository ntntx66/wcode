import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Bot } from '../src/bot.ts';
import { Store, initialState } from '../src/store.ts';
import { run } from '../src/agents/run.ts';
import type { RunOptions } from '../src/agents/run.ts';
import { codex } from '../src/agents/codex.ts';
import { fileInstructions } from '../src/files.ts';
import { Ilink, IlinkError } from '../src/wechat/ilink.ts';
import { auth, channel, eventually, message, setup, untilAbort } from './helpers.ts';

test('configuration changes are durable independently of reply sending', t => {
  const { home, store, config } = setup(t);
  const bot = new Bot(store, config, auth, channel());
  bot.replies.send = () => {};
  const project = `${home}/project`;
  mkdirSync(project);
  let cursor = 0;
  const send = (text: string) => bot.accept({ get_updates_buf: String(++cursor), msgs: [message(text)] });
  const disk = () => new Store(home, initialState('pi', home)).state;
  store.state.pages = ['old page'];
  send('/agent codex');
  assert.equal(disk().agent, 'codex');
  assert.deepEqual(disk().pages, []);
  send(`/cd ${project}`);
  assert.equal(disk().cwd, project);
  send('/model selected');
  assert.equal(disk().models.codex, 'selected');
  store.state.sessions[`codex:${project}`] = 'old-session';
  store.save();
  send('/new');
  assert.equal(disk().sessions[`codex:${project}`], undefined);
});

test('task completion and its result commit together; a failed commit never sends the result', async t => {
  const { home, store, config } = setup(t);
  let failCommit = true;
  const save = store.save.bind(store);
  store.save = () => {
    if (store.state.task?.status === 'succeeded') {
      assert.ok(store.state.outbox.some(item => item.text === 'durable result'));
      if (failCommit) throw new Error('disk full');
    }
    save();
  };
  const sent: string[] = [];
  const bot = new Bot(store, config, auth, channel(sent), async () => {
    const disk = new Store(home, initialState('pi', home)).state;
    assert.equal(disk.task?.status, 'running');
    assert.equal(disk.task?.inputs[0].text, 'work');
    assert.deepEqual(disk.pages, []);
    return 'durable result';
  }, () => {});
  store.state.pages = ['old page'];
  bot.accept({ get_updates_buf: '1', msgs: [message('work')] });
  await bot.active?.done;
  await bot.replies.pending;
  assert.match(String(bot.failure), /disk full/);
  assert.deepEqual(sent, []);
  assert.equal(new Store(home, initialState('pi', home)).state.task?.status, 'running');
  failCommit = false;
  save();
  const restored = new Store(home, initialState('pi', home));
  assert.equal(restored.state.task?.status, 'succeeded');
  assert.equal(restored.state.outbox[0].text, 'durable result');
});

test('cursor is durable before execution; duplicate cursor, strangers and failed persistence never execute', async t => {
  const { store, config } = setup(t); let runs = 0;
  const bot = new Bot(store, config, auth, channel(), async () => {
    assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).cursor, 'c1'); runs++; return 'done';
  }, () => {});
  const batch = { get_updates_buf: 'c1', msgs: [{ ...message('ignored'), from_user_id: 'stranger' }, message('work')] };
  bot.accept(batch); bot.accept(batch); await bot.active?.done;
  assert.equal(runs, 1);
  assert.throws(() => bot.accept({ msgs: [message('unsafe')] }), /游标/);
  store.save = () => { throw new Error('disk full'); };
  assert.throws(() => bot.accept({ get_updates_buf: 'c2', msgs: [message('unsafe')] }), /disk full/);
  assert.equal(runs, 1); bot.controller.abort(); await bot.replies.pending;
});
test('queued messages merge once; sessions persist immediately and channel rules stay in the system prompt every turn', async t => {
  const { home, store, config } = setup(t), calls: RunOptions[] = [], finish: ((text: string) => void)[] = [];
  const bot = new Bot(store, config, auth, channel(), async (_spec, o) => {
    calls.push(o); o.onEvent({ type: 'session', id: 'persisted-session' });
    return new Promise(resolve => finish.push(resolve));
  }, () => {});
  bot.accept({ get_updates_buf: '1', msgs: [message('one'), message('two'), message('three')] });
  assert.equal(calls.length, 1); assert.equal(bot.queuedCount, 2); assert.equal(calls[0].prompt, 'one');
  assert.match(calls[0].system ?? '', /^\[微信通道\]\n你的回复会发到微信/); assert.ok(calls[0].system?.endsWith(fileInstructions));
  assert.equal(new Store(home, initialState('pi', home)).state.sessions[`claude:${home}`], 'persisted-session');
  finish[0]('first result'); await eventually(() => calls.length === 2);
  assert.equal(calls[1].prompt, 'two\n\nthree'); assert.equal(calls[1].system, calls[0].system); assert.equal(calls[1].sessionId, 'persisted-session');
  finish[1]('second result'); await eventually(() => !bot.active && !bot.replies.pending);
});
test('commands stay responsive while sends are blocked; stop clears queue and prevents switches until exit', async t => {
  const { store, config } = setup(t), calls: RunOptions[] = [];
  const api = channel(); api.send = async (_text, _token, _id, signal) => { await untilAbort(signal!); throw new Error('aborted'); };
  const bot = new Bot(store, config, auth, api, async (_spec, o) => {
    calls.push(o); o.onEvent({ type: 'tool', name: 'bash', detail: 'long job' }); await untilAbort(o.signal); o.signal.throwIfAborted(); return '';
  }, () => {});
  bot.accept({ get_updates_buf: '1', msgs: [message('run'), message('queued'), message('/status'), message('/agent 2')] });
  assert.equal(store.state.agent, 'claude'); assert.equal(bot.queuedCount, 1);
  assert.ok(store.state.outbox.some(x => x.text.includes('bash：long job')));
  bot.accept({ get_updates_buf: '2', msgs: [message('/停止')] });
  assert.equal(bot.queuedCount, 0); assert.ok(calls[0].signal.aborted);
  await bot.active?.done; assert.equal(calls.length, 1);
  bot.controller.abort(); await bot.replies.pending;
});
test('exact command matching, aliases, model reset, project session reuse and /new scope', async t => {
  const { home, store, config } = setup(t), prompts: string[] = [];
  config.projects.project = home;
  const bot = new Bot(store, config, auth, channel(), async (_spec, o) => { prompts.push(o.prompt); return 'done'; }, () => {});
  let cursor = 0;
  const send = (text: string) => bot.accept({ get_updates_buf: String(++cursor), msgs: [message(text)] });
  send('/agent 2'); assert.equal(store.state.agent, 'codex');
  send('/model custom'); assert.equal(store.state.models.codex, 'custom');
  send('/model default'); assert.equal(store.state.models.codex, undefined);
  send('/cd project'); assert.equal(store.state.cwd, home);
  send('/cd 99'); assert.equal(store.state.cwd, home);
  store.state.sessions[`codex:${home}`] = 'codex-session'; store.state.sessions[`claude:${home}`] = 'claude-session';
  send('/agent 1'); send('/new'); assert.equal(store.state.sessions[`claude:${home}`], undefined);
  send('/agent 2'); assert.equal(store.state.sessions[`codex:${home}`], 'codex-session');
  for (const text of ['/Users/me/a.ts 这里有 bug', '/statusXYZ', '1']) { send(text); await bot.active?.done; }
  assert.deepEqual(prompts, ['/Users/me/a.ts 这里有 bug', '/statusXYZ', '1']);
  send('/帮助'); send('/状态'); send('/更多');
  await eventually(() => !bot.replies.pending);
});
test('turn timeout aborts the runner, and invalid auth stops polling', async t => {
  const { store, config } = setup(t); config.turnTimeoutMinutes = 0.0002;
  const bot = new Bot(store, config, auth, channel(), async (_spec, o) => { await untilAbort(o.signal); o.signal.throwIfAborted(); return ''; }, () => {});
  bot.accept({ get_updates_buf: '1', msgs: [message('hang')] });
  await bot.active?.done; await eventually(() => !bot.replies.pending);
  let polls = 0;
  const api = channel(); api.updates = async () => { polls++; throw new IlinkError(-14, 'relogin'); };
  await assert.rejects(new Bot(store, config, auth, api).start(), /relogin/); assert.equal(polls, 1);
});
test('HTTP iLink → stdin child → final WeChat reply works end to end and resumes after restart', async t => {
  const { home, store, config } = setup(t); config.defaultAgent = 'codex'; store.state.agent = 'codex';
  const sent: Record<string, unknown>[] = [], seenCursors: string[] = [];
  let batch = 0;
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    const body = JSON.parse(data); res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/getupdates')) {
      seenCursors.push(body.get_updates_buf);
      if (batch < 2) { batch++; res.end(JSON.stringify({ get_updates_buf: String(batch), msgs: [message(batch === 1 ? 'first' : '/status')] })); }
      return; // Leave the next long poll open; shutdown must abort it.
    }
    if (req.url?.endsWith('/sendmessage')) sent.push(body.msg);
    res.end(JSON.stringify({ ret: 0, typing_ticket: 'test-ticket' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const localAuth = { ...auth, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  const execute: typeof run = (spec, options) => run({ ...spec, command: process.execPath, args: () => ['-e', `
    let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{
    console.log(JSON.stringify({type:'thread.started',thread_id:'http-session'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'result:'+prompt}}));});`], parseLine: codex.parseLine }, options);
  const controller = new AbortController(), bot = new Bot(store, config, auth, new Ilink(localAuth), execute, () => {});
  const running = bot.start(controller.signal);
  t.after(async () => { controller.abort(); await running; });
  await eventually(() => sent.some(m => JSON.stringify(m).includes('result:first')) && !store.state.outbox.length);
  controller.abort(); await running;
  assert.equal(store.state.sessions[`codex:${home}`], 'http-session');
  assert.ok(seenCursors.includes('1')); assert.ok(seenCursors.includes('2'));
  assert.ok(sent.every(m => m.to_user_id === 'owner' && m.context_token === 'context'));
  const restored = new Store(home, initialState('claude', home)); let resumed: RunOptions | undefined;
  const second = new Bot(restored, config, auth, channel(), async (_spec, o) => { resumed = o; return 'continued'; }, () => {});
  second.accept({ get_updates_buf: '3', msgs: [message('continue')] }); await second.active?.done;
  assert.equal(resumed?.sessionId, 'http-session'); assert.equal(resumed?.prompt, 'continue');
  await eventually(() => !second.replies.pending);
});
