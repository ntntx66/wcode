import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bot } from '../src/bot.ts';
import { loadConfig } from '../src/config.ts';
import { run } from '../src/agents/run.ts';
import { textAgent } from '../src/agents/text.ts';
import { codex } from '../src/agents/codex.ts';
import { pi } from '../src/agents/pi.ts';
import { initialState, Store, writeJson } from '../src/store.ts';
import { launchdPlist, serviceLabel } from '../src/service.ts';
import { digest } from '../src/files.ts';
import { auth, channel, eventually, message, setup, untilAbort } from './helpers.ts';

test('configured text CLI executes literal stdin, returns all stdout and reports nonzero exit', async t => {
  const { home } = setup(t);
  writeJson(join(home, 'config.json'), { defaultAgent: 'local', agents: { local: { type: 'text', command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)', '{model}'] } } });
  const config = loadConfig(home), spec = textAgent('local', config.agents.local);
  const prompt = '-x $(touch unwanted)\n中文\nlast line';
  assert.equal(await run(spec, { prompt, system: 'SYS', model: 'literal-model', cwd: home, signal: new AbortController().signal, onEvent: () => assert.fail('text CLI should not emit structured events') }), 'SYS\n\n' + prompt);
  const fail = textAgent('bad', { command: process.execPath, extraArgs: [], args: ['-e', 'console.log("partial");console.error("failed");process.exitCode=2'] });
  await assert.rejects(run(fail, { prompt: '', cwd: home, signal: new AbortController().signal, onEvent: () => assert.fail('text CLI should not emit structured events') }), /failed/);
  const store = new Store(home, initialState('local', home)); store.save();
  assert.equal(new Store(home, initialState('claude', home)).state.agent, 'local');
  const sent: string[] = [], bot = new Bot(store, config, auth, channel(sent));
  bot.accept({ get_updates_buf: '1', msgs: [message('/agent 4'), message('/status'), message('echo me')] });
  await bot.active?.done; await eventually(() => !bot.replies.pending);
  assert.equal(store.state.agent, 'local'); assert.ok(sent.some(text => text.includes('无会话恢复'))); assert.ok(sent.some(text => text.includes('echo me')));
  assert.equal(Object.keys(store.state.sessions).length, 0);
  for (const agents of [{ custom: {} }, { constructor: { type: 'text' } }, { claude: { type: 'text' } }, { custom: { type: 'text', args: 'bad' } }]) {
    writeJson(join(home, 'config.json'), { agents }); assert.throws(() => loadConfig(home));
  }
});

test('native image arguments stay literal in both new and resumed sessions', () => {
  const images = ['/tmp/图片 with spaces.png', '/tmp/second.jpg'];
  for (const sessionId of [undefined, 'existing']) {
    const args = codex.args({ images, sessionId });
    assert.equal(args.filter(arg => arg === '-i').length, 2); assert.ok(images.every(path => args.includes(path)));
    assert.equal(args.at(-1), '-'); if (sessionId) assert.ok(args.includes('resume'));
  }
  assert.ok(pi.args({ images, sessionId: 'existing' }).includes('@/tmp/图片 with spaces.png'));
});

test('media downloads are cancellable while commands remain responsive; failures never execute agent', async t => {
  const { store, config } = setup(t); let runs = 0, downloading = false;
  const sent: string[] = [], bot = new Bot(store, config, auth, channel(sent), async () => { runs++; return 'done'; }, () => {});
  bot.download = async (_attachment, _home, signal) => { downloading = true; await untilAbort(signal); signal.throwIfAborted(); throw new Error('unreachable'); };
  const img = { ...message(''), item_list: [{ type: 2, image_item: {} }] };
  bot.accept({ get_updates_buf: '1', msgs: [img, message('queued'), message('/status'), message('/stop')] });
  assert.ok(downloading); assert.equal(bot.queue.length, 0);
  await bot.active?.done; await eventually(() => !bot.replies.pending);
  assert.equal(runs, 0); assert.ok(sent.some(text => text.includes('下载微信附件'))); assert.ok(sent.some(text => text.includes('任务已停止')));
  bot.download = async () => { throw new Error('cannot decrypt'); };
  bot.accept({ get_updates_buf: '2', msgs: [img] }); await bot.active?.done; await eventually(() => !bot.replies.pending);
  assert.equal(runs, 0); assert.ok(sent.some(text => text.includes('cannot decrypt')));
});

test('image/file prompt and native inputs reach agent; generated file and /send enter durable outbox', async t => {
  const { home, store, config } = setup(t); store.state.agent = 'codex';
  const image = join(home, 'image.png'), output = join(home, 'result.txt'); writeFileSync(image, 'image fixture'); writeFileSync(output, 'file result');
  const api = channel(), files: string[] = [];
  api.uploadFile = async file => {
    files.push(readFileSync(file.path, 'utf8'));
    return { type: 4, file_item: { file_name: file.name, len: String(file.size), media: { encrypt_query_param: 'p', aes_key: 'k', encrypt_type: 1 } } };
  };
  api.sendFile = async () => {};
  const bot = new Bot(store, config, auth, api, async (_spec, options) => {
    assert.deepEqual(options.images, [image]); assert.ok(options.prompt.includes(image)); assert.match(options.prompt, /请分析收到的附件/);
    return `completed\nWCODE_FILE: ${output}`;
  });
  bot.download = async () => ({ path: image, name: 'image.png', size: 13, sha256: digest(Buffer.from('image fixture')), kind: 'image' });
  bot.accept({ get_updates_buf: '1', msgs: [{ ...message(''), item_list: [{ type: 2, image_item: {} }] }] });
  await bot.active?.done; await eventually(() => !bot.replies.pending);
  assert.deepEqual(files, ['file result']);
  bot.accept({ get_updates_buf: '2', msgs: [message('/send result.txt')] }); await eventually(() => !bot.replies.pending);
  assert.deepEqual(files, ['file result', 'file result']);
});

test('launchd plist uses absolute runtime, escaped paths, isolated label and valid property list', t => {
  const { home } = setup(t), path = join(home, 'agent.plist');
  const xml = launchdPlist(join(home, 'a&b'), '/tmp/project & spaces/dist/cli.js', home, '/bin:/a&b'); writeFileSync(path, xml);
  assert.ok(xml.includes('&amp;')); assert.ok(xml.includes('<string>start</string>')); assert.ok(xml.includes('SuccessfulExit')); assert.ok(xml.includes('WCODE_HOME'));
  assert.notEqual(serviceLabel(home), serviceLabel(home + '2'));
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/bin/plutil', ['-lint', path], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test('agent errors cannot trigger file declarations', async t => {
  const { home, store, config } = setup(t), path = join(home, 'secret.txt'); writeFileSync(path, 'do not send');
  const api = channel(); api.uploadFile = async () => assert.fail('error text must never upload');
  const bot = new Bot(store, config, auth, api, async () => { throw new Error(`failed\nWCODE_FILE: ${path}`); });
  bot.accept({ get_updates_buf: '1', msgs: [message('run')] }); await bot.active?.done; await eventually(() => !bot.replies.pending);
  assert.equal(store.state.outbox.length, 0);
});
