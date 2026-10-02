import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { claude } from '../src/agents/claude.ts';
import { codex } from '../src/agents/codex.ts';
import { pi } from '../src/agents/pi.ts';
import { run } from '../src/agents/run.ts';
import type { AgentEvent } from '../src/agents/types.ts';
import { Bot } from '../src/bot.ts';
import { Replies, splitReply } from '../src/reply.ts';
import { Store, initialState } from '../src/store.ts';
import { IlinkError } from '../src/wechat/ilink.ts';
import { auth, channel, eventually, message, setup, untilAbort } from './helpers.ts';

for (const spec of [claude, codex, pi]) test(`${spec.name}: recorded complete text is forwarded in order with the repeated final event removed`, async t => {
  const { home } = setup(t), events: AgentEvent[] = [];
  const jsonl = readFileSync(new URL(`./fixtures/${spec.name}-progress.jsonl`, import.meta.url), 'utf8');
  const result = await run({ ...spec, command: process.execPath, args: () => ['-e', `process.stdin.resume();process.stdout.write(${JSON.stringify(jsonl)});`] }, {
    prompt: 'probe', cwd: home, signal: new AbortController().signal, onEvent: e => events.push(e),
  });
  assert.equal(result, 'FINAL: 两个命令都已完成。');
  assert.deepEqual(events.map(e => e.type), ['text', 'tool', 'text', 'tool', 'text']);
  const progress = events.filter(e => e.type === 'text');
  assert.match(progress[0].text, /目录|命令/);
  assert.match(progress[1].text, /第二/);
  assert.equal(events.filter(e => e.type === 'text' && e.text === result).length, 1);
});

test('runner preserves the final fallback but rejects nonzero exit even after visible text', async t => {
  const { home } = setup(t);
  const progress = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '先检查。' } });
  const tool = JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'pwd' } });
  const events: AgentEvent[] = [];
  const options = { prompt: '', cwd: home, signal: new AbortController().signal, onEvent: (e: AgentEvent) => events.push(e) };
  const spec = { ...codex, command: process.execPath, args: () => ['-e', `console.log(${JSON.stringify(progress)});console.log(${JSON.stringify(tool)});`] };
  assert.equal(await run(spec, options), '先检查。');
  assert.deepEqual(events.map(e => e.type), ['text', 'tool']);
  events.length = 0;
  await assert.rejects(run({ ...spec, args: () => ['-e', `console.log(${JSON.stringify(progress)});console.error('failed process');process.exitCode=9;`] }, options), /failed process/);
  assert.deepEqual(events, [{ type: 'text', text: '先检查。' }]);
});

test('Claude handles text and tool blocks in the same message without publishing thought or child-agent text', async t => {
  const { home } = setup(t), events: AgentEvent[] = [];
  const rows = [
    { type: 'assistant', parent_tool_use_id: 'nested', message: { content: [{ type: 'text', text: 'child-private' }] } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: '先读取。' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.txt' } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '结束。' }] } },
    { type: 'result', result: '结束。', is_error: false },
  ];
  const result = await run({ ...claude, command: process.execPath, args: () => ['-e', `for(const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row));`] }, {
    prompt: '', cwd: home, signal: new AbortController().signal, onEvent: e => events.push(e),
  });
  assert.equal(result, '结束。');
  assert.deepEqual(events, [{ type: 'text', text: '先读取。' }, { type: 'tool', name: 'Read', detail: 'a.txt' }, { type: 'text', text: '结束。' }]);
});

test('text is delivered before any tool or terminal event, with no classification wait', async t => {
  const { home } = setup(t), events: AgentEvent[] = [];
  const spec = { ...codex, command: process.execPath, args: () => ['-e', `
    const fs = require('node:fs');
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'准备检查。'}}));
    const timer=setInterval(()=>{if(fs.existsSync('text-received')){
      clearInterval(timer);
      console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'pwd'}}));
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'完成。'}}));
    }},10);`] };
  const result = await run(spec, { prompt: '', cwd: home, signal: AbortSignal.timeout(3000), onEvent: e => {
    events.push(e); if (e.type === 'text' && e.text === '准备检查。') writeFileSync(`${home}/text-received`, 'ok');
  } });
  assert.equal(result, '完成。'); assert.deepEqual(events.map(e => e.type), ['text', 'tool', 'text']);
});

test('progress sends every message in order with the latest token, without state writes, pagination or file upload', async t => {
  const { home, store } = setup(t); store.state.contextToken = 'old'; store.state.pages = ['saved page']; store.save();
  const before = readFileSync(store.path, 'utf8'), sent: { text: string; token: string; id: string }[] = [];
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  const api = channel();
  api.send = async (text, token, id) => { sent.push({ text, token, id }); if (sent.length === 1) await first; };
  api.uploadFile = async () => assert.fail('progress must never upload a file');
  const controller = new AbortController(), replies = new Replies(store, api, controller.signal, e => assert.fail(String(e)));
  const long = '第二条😀\n'.repeat(1600);
  replies.stream('第一条', controller.signal); replies.stream(long, controller.signal);
  assert.equal(sent.length, 1); assert.equal(store.state.outbox.length, 0);
  store.state.contextToken = 'new'; release(); await eventually(() => !replies.pending);
  assert.deepEqual(sent.map(x => x.text), ['第一条', ...splitReply(long)]);
  assert.ok(sent.length > 4); assert.ok(sent.every(x => x.text.length <= 2000));
  assert.equal(sent[0].token, 'old'); assert.ok(sent.slice(1).every(x => x.token === 'new'));
  assert.equal(new Set(sent.map(x => x.id)).size, sent.length);
  assert.equal(readFileSync(store.path, 'utf8'), before);
  const restored = new Store(home, initialState('claude', home));
  assert.deepEqual(restored.state.outbox, []); assert.deepEqual(restored.state.pages, ['saved page']);
});

test('failed progress is attempted once and does not block later progress or a durable result', async t => {
  const { store } = setup(t); store.state.contextToken = 'token'; store.save();
  const sent: string[] = [], errors: unknown[] = [], api = channel();
  api.send = async text => { sent.push(text); if (text === 'failed progress') throw new Error('offline'); };
  const controller = new AbortController(), replies = new Replies(store, api, controller.signal, e => errors.push(e));
  replies.stream('failed progress', controller.signal); replies.stream('next progress', controller.signal);
  await eventually(() => !replies.pending);
  assert.equal(errors.length, 1); assert.equal(replies.blocked, false); assert.deepEqual(store.state.outbox, []);
  replies.result('final result'); await eventually(() => !replies.pending);
  assert.deepEqual(sent, ['failed progress', 'next progress', 'final result']);
});

test('acknowledged final text is not repeated; file declarations are hidden until successful completion', async t => {
  const { home, store } = setup(t); store.state.contextToken = 'token';
  writeFileSync(`${home}/output.txt`, 'file result');
  const sent: string[] = [], api = channel(sent); let uploads = 0, files = 0;
  api.uploadFile = async () => { uploads++; return { type: 4, file_item: { file_name: 'output.txt', len: '11', media: { encrypt_query_param: 'cdn', aes_key: 'key', encrypt_type: 1 } } }; };
  api.sendFile = async () => { files++; };
  const controller = new AbortController(), replies = new Replies(store, api, controller.signal, e => assert.fail(String(e)));
  const raw = `完成。\nWCODE_FILE: ${home}/output.txt`;
  const live = replies.stream(raw, controller.signal); await eventually(() => !replies.pending);
  assert.deepEqual(sent, ['完成。']); assert.equal(uploads, 0);
  replies.result(raw, home, live); await eventually(() => !replies.pending);
  assert.deepEqual(sent, ['完成。']); assert.equal(uploads, 1); assert.equal(files, 1);
  assert.deepEqual(store.state.outbox, []);
  replies.result(`完成。\nWCODE_FILE: ${home}/missing.txt`, home, live); await eventually(() => !replies.pending);
  assert.equal(sent.length, 2); assert.match(sent[1], /^❌ 文件回传：/); assert.equal(sent.filter(x => x === '完成。').length, 1);
});

test('a partially delivered final answer persists only missing segments and reuses their client IDs', async t => {
  const { home, store } = setup(t); store.state.contextToken = 'token';
  const controller = new AbortController(), attempts: { text: string; id: string }[] = [], api = channel();
  let offline = false;
  api.send = async (text, _token, id) => { attempts.push({ text, id }); if (offline) throw new Error('offline'); offline = true; };
  const replies = new Replies(store, api, controller.signal, () => {}, 1);
  const raw = '长答案😀'.repeat(600), parts = splitReply(raw);
  const live = replies.stream(raw, controller.signal)!; await eventually(() => !replies.pending);
  assert.equal(live.parts[0].sent, true); assert.ok(live.parts.slice(1).every(x => !x.sent));
  replies.result(raw, home, live); await eventually(() => !replies.pending);
  assert.deepEqual(store.state.outbox.map(x => x.text), parts.slice(1));
  assert.deepEqual(store.state.outbox.map(x => x.id), live.parts.slice(1).map(x => x.id));
  assert.equal(attempts.filter(x => x.text === parts[0]).length, 1);
  const restored = new Store(home, initialState('claude', home));
  assert.deepEqual(restored.state.outbox, store.state.outbox);
});

test('bot sends all completed assistant text immediately and does not resend an acknowledged final answer', async t => {
  const { store, config } = setup(t), sent: string[] = [], api = channel(sent);
  const bot = new Bot(store, config, auth, api, async (_spec, options) => {
    options.onEvent({ type: 'text', text: '开始查看。' }); await eventually(() => sent.includes('开始查看。'));
    options.onEvent({ type: 'text', text: '完成。' }); await eventually(() => sent.includes('完成。'));
    return '完成。';
  }, () => {});
  bot.accept({ get_updates_buf: '1', msgs: [message('work')] }); await bot.active?.done;
  await eventually(() => !bot.replies.pending);
  assert.deepEqual(sent, ['开始查看。', '完成。']); assert.equal(store.state.task?.status, 'succeeded');
  assert.deepEqual(store.state.outbox, []);
});

test('a command response preempts a hanging progress send', async t => {
  const { store } = setup(t); store.state.contextToken = 'token';
  const sent: string[] = [], api = channel(); let progressSignal: AbortSignal | undefined;
  api.send = async (text, _token, _id, signal) => {
    if (text === 'progress') { progressSignal = signal; await untilAbort(signal!); signal!.throwIfAborted(); }
    sent.push(text);
  };
  const controller = new AbortController(), replies = new Replies(store, api, controller.signal, e => assert.fail(String(e)));
  replies.stream('progress', controller.signal); replies.send('command response');
  await eventually(() => !replies.pending);
  assert.ok(progressSignal?.aborted); assert.deepEqual(sent, ['command response']);
});

for (const stop of [false, true]) test(`bot ${stop ? 'cancels live text on stop' : 'finishes queued live text after a failed send'} and sends the result once`, async t => {
  const { store, config } = setup(t), sent: string[] = [], api = channel();
  let finish!: (value: string) => void, progressSignal: AbortSignal | undefined;
  api.send = async (text, _token, _id, signal) => {
    if (text === 'in flight') { progressSignal = signal; await untilAbort(signal!); signal!.throwIfAborted(); }
    sent.push(text);
  };
  const bot = new Bot(store, config, auth, api, async (_spec, options) => {
    options.onEvent({ type: 'text', text: 'in flight' }); options.onEvent({ type: 'text', text: 'queued progress' });
    if (stop) { await untilAbort(options.signal); options.signal.throwIfAborted(); }
    return new Promise<string>(resolve => { finish = resolve; });
  }, () => {});
  bot.accept({ get_updates_buf: '1', msgs: [message('work')] });
  await eventually(() => !!progressSignal);
  if (stop) bot.accept({ get_updates_buf: '2', msgs: [message('/stop')] }); else finish('final');
  await bot.active?.done; await eventually(() => !bot.replies.pending);
  assert.ok(progressSignal?.aborted);
  assert.equal(sent.includes('queued progress'), !stop); assert.ok(!sent.includes('in flight'));
  assert.equal(sent.filter(x => stop ? x.startsWith('❌') : x === 'final').length, 1);
  assert.equal(store.state.task?.status, stop ? 'stopped' : 'succeeded');
});

test('expired authentication during progress aborts execution and preserves only the final error in outbox', async t => {
  const { store, config } = setup(t), api = channel();
  api.send = async () => { throw new IlinkError(-14, 'expired'); };
  const bot = new Bot(store, config, auth, api, async (_spec, options) => {
    options.onEvent({ type: 'text', text: 'temporary progress' });
    await untilAbort(options.signal); options.signal.throwIfAborted(); return '';
  }, () => {});
  bot.accept({ get_updates_buf: '1', msgs: [message('work')] }); await bot.active?.done;
  await eventually(() => !bot.replies.pending);
  assert.ok(bot.controller.signal.aborted); assert.equal(store.state.task?.status, 'interrupted');
  assert.equal(store.state.outbox.length, 1); assert.match(store.state.outbox[0].text, /expired/);
  assert.ok(!readFileSync(store.path, 'utf8').includes('temporary progress'));
});

test('missing context, blocked replies and an aborted turn do not queue progress for later delivery', async t => {
  const { store } = setup(t), sent: string[] = [], controller = new AbortController();
  const replies = new Replies(store, channel(sent), controller.signal, e => assert.fail(String(e)));
  replies.stream('no token', controller.signal);
  store.state.contextToken = 'token'; replies.blocked = true; replies.stream('blocked', controller.signal);
  replies.resume(); replies.stream('stale', AbortSignal.abort());
  await eventually(() => !replies.pending); assert.deepEqual(sent, []); assert.deepEqual(store.state.outbox, []);
});
