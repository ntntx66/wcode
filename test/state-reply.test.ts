import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireLock, initialState, Store, writeJson } from '../src/store.ts';
import { loadConfig } from '../src/config.ts';
import { Replies, splitReply } from '../src/reply.ts';
import { IlinkError } from '../src/wechat/ilink.ts';
import { eventually, setup } from './helpers.ts';

test('atomic state and credentials have private modes; malformed state fails closed', t => {
  const { home, store } = setup(t);
  store.state.cursor = 'committed'; store.state.sessions['claude:/a'] = 's'; store.save();
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  assert.equal(new Store(home, initialState('pi', '/b')).state.cursor, 'committed');
  writeJson(join(home, 'auth.json'), { token: 'secret' });
  assert.equal(statSync(join(home, 'auth.json')).mode & 0o777, 0o600);
  writeFileSync(store.path, '{broken'); assert.throws(() => new Store(home, initialState('pi', home)), /无法读取/);
  writeJson(store.path, { ...store.state, outbox: ['broken'] }); assert.throws(() => new Store(home, initialState('pi', home)), /格式无效/);
});
test('exclusive live lock, stale recovery, and release are safe across processes', t => {
  const { home } = setup(t), release = acquireLock(home);
  const module = new URL('../src/store.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { acquireLock } from ${JSON.stringify(module)}; acquireLock(process.argv[1])();`, home], { encoding: 'utf8' });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /已在运行/); release();
  writeJson(join(home, 'wcode.lock'), { pid: 2_147_483_647 });
  const releaseRecovered = acquireLock(home); releaseRecovered();
});
test('configuration validates timeout and argument types and resolves project aliases', t => {
  const { home } = setup(t);
  writeJson(join(home, 'config.json'), { projects: { project: home }, agents: { pi: { extraArgs: ['-a'] } } });
  assert.deepEqual(loadConfig(home).agents.pi.extraArgs, ['-a']);
  for (const config of [{ turnTimeoutMinutes: 0 }, { defaultAgent: 'invalid' }, { agents: [] }, { projects: 'bad' }, { agents: { pi: null } }, { agents: { claude: { extraArgs: '-bad' } } }]) {
    writeJson(join(home, 'config.json'), config); assert.throws(() => loadConfig(home));
  }
});
test('splitting respects paragraphs, Unicode and the 2000-unit limit including page hints', t => {
  const { store } = setup(t), abort = new AbortController(); store.state.contextToken = 'c';
  const sent: string[] = [], replies = new Replies(store, { send: async text => { sent.push(text); } }, abort.signal, assert.fail);
  assert.deepEqual(splitReply('a\n\n![x](https://example.com/a(b).png)\n**b**'), ['a\n\n\n**b**']);
  assert.deepEqual(splitReply('段落一\n\n段落二'), ['段落一\n\n段落二']);
  const raw = '👋中文\n'.repeat(2_000);
  const parts = splitReply(raw); assert.ok(parts.length > 3);
  for (const part of parts) { assert.ok(part.length <= 2_000); assert.ok(!/\p{Surrogate}/u.test(part)); }
  replies.result(raw); assert.equal(store.state.pages.length, parts.length - 3);
  assert.equal(store.state.outbox.length, 3); assert.match(store.state.outbox[2].text, /发送 \/more/);
  for (const item of store.state.outbox) assert.ok(item.text.length <= 2_000);
  replies.more(); assert.equal(store.state.pages.length, Math.max(parts.length - 6, 0));
  replies.clearPages(); assert.deepEqual(store.state.pages, []);
  t.after(async () => { await eventually(() => !replies.pending); });
});
test('retry exhaustion persists ordered outbox and reuses IDs with the latest context after restart', async t => {
  const { home, store } = setup(t), abort = new AbortController(); store.state.contextToken = 'old';
  const calls: { text: string; token: string; id: string }[] = [];
  const errors: unknown[] = [];
  const replies = new Replies(store, { send: async (text, token, id) => { calls.push({ text, token, id }); throw new Error('rate limit'); } }, abort.signal, e => errors.push(e), 1);
  replies.send('first'); replies.send('second');
  await eventually(() => !replies.pending);
  assert.equal(calls.length, 4); assert.equal(new Set(calls.map(x => x.id)).size, 1); assert.equal(errors.length, 1);
  const restored = new Store(home, initialState('claude', home)); restored.state.contextToken = 'fresh';
  const retry = new Replies(restored, { send: async (text, token, id) => { calls.push({ text, token, id }); } }, abort.signal, assert.fail);
  retry.resume(); await eventually(() => !retry.pending);
  assert.deepEqual(calls.slice(-2).map(x => [x.text, x.token]), [['first', 'fresh'], ['second', 'fresh']]);
  assert.equal(calls[0].id, calls.at(-2)?.id); assert.equal(restored.state.outbox.length, 0);
  assert.equal(JSON.parse(readFileSync(restored.path, 'utf8')).outbox.length, 0);
});
test('an empty flush followed immediately by a reply still sends; stale auth fails fast', async t => {
  const { store } = setup(t), abort = new AbortController(), sent: string[] = []; store.state.contextToken = 'c';
  const replies = new Replies(store, { send: async text => { sent.push(text); } }, abort.signal, assert.fail);
  replies.resume(); replies.send('command response'); await eventually(() => sent.length === 1 && !replies.pending);
  let attempts = 0;
  const stale = new Replies(store, { send: async () => { attempts++; throw new IlinkError(-14, 'expired'); } }, abort.signal, () => {});
  stale.send('keep me'); await eventually(() => !stale.pending);
  assert.equal(attempts, 1); assert.equal(store.state.outbox[0].text, 'keep me');
});
test('long command responses are paginated and image references are stripped', async t => {
  const { store } = setup(t), abort = new AbortController();
  const replies = new Replies(store, { send: async () => {} }, abort.signal, assert.fail);
  assert.deepEqual(splitReply('before ![image][ref] after'), ['before  after']);
  replies.send('长'.repeat(15_000));
  assert.equal(store.state.outbox.length, 3); assert.ok(store.state.pages.length > 0);
  await eventually(() => !replies.pending);
});
test('a new context received during the last failed send triggers recovery without another inbound message', async t => {
  const { store } = setup(t), abort = new AbortController(); store.state.contextToken = 'old';
  let attempts = 0, rejectLast: ((e: Error) => void) | undefined;
  const tokens: string[] = [];
  const replies = new Replies(store, { send: async (_text, token) => {
    tokens.push(token); attempts++;
    if (attempts < 4) throw new Error('busy');
    if (attempts === 4) await new Promise((_resolve, reject) => { rejectLast = reject; });
  } }, abort.signal, assert.fail, 1);
  replies.send('result'); await eventually(() => !!rejectLast);
  store.state.contextToken = 'new'; replies.resume(); rejectLast!(new Error('old attempt failed'));
  await eventually(() => !replies.pending);
  assert.equal(tokens.at(-1), 'new'); assert.equal(store.state.outbox.length, 0);
});
