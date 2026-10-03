import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { doctor, cleanMedia, executable, mediaUsage } from '../src/maintenance.ts';
import { LOG_BACKUPS, rotateLog } from '../src/logs.ts';
import { acquireLock, Store, initialState } from '../src/store.ts';
import { writeJson } from '../src/json.ts';
import { saveMedia } from '../src/files.ts';
import { VERSION } from '../src/config.ts';
import { auth, setup } from './helpers.ts';

test('doctor checks local config, executable availability, state, private auth and snapshots without writing', t => {
  const { home, store } = setup(t), command = join(home, 'cli with spaces'); writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeJson(join(home, 'config.json'), { defaultAgent: 'local', agents: { local: { type: 'text', command, args: [] } } });
  store.state.agent = 'local'; store.state.outbox.push({ id: 'file', text: '', file: saveMedia(home, 'outbound', 'output.txt', Buffer.from('snapshot')) }); store.save();
  writeJson(join(home, 'auth.json'), auth);
  const before = readdirSync(home).map(name => [name, statSync(join(home, name)).mtimeMs]);
  const checks = doctor(home);
  assert.deepEqual(checks.filter(check => check.level === 'ERROR'), []);
  assert.ok(checks.some(check => check.name === 'agent local' && check.detail === command));
  assert.ok(checks.some(check => check.name === '媒体占用' && check.detail.includes('8 B')));
  assert.deepEqual(readdirSync(home).map(name => [name, statSync(join(home, name)).mtimeMs]), before);
  assert.ok(!JSON.stringify(checks).includes(auth.token));
  chmodSync(command, 0o600); chmodSync(join(home, 'auth.json'), 0o644);
  assert.ok(doctor(home).some(check => check.name === 'agent local' && check.level === 'ERROR'));
  assert.ok(doctor(home).some(check => check.name === 'auth.json 权限' && check.level === 'WARN'));
  writeFileSync(store.state.outbox[0].file!.path, 'changed');
  assert.ok(doctor(home).some(check => check.name === '待补发文件' && check.level === 'ERROR'));
  assert.equal(executable('cli with spaces', home, home), undefined);
});

test('cleanup previews and deletes only old unreferenced media while preserving session and outbox files', t => {
  const { home, store } = setup(t);
  const old = new Date(Date.now() - 40 * 86_400_000);
  const file = (bucket: 'inbound' | 'outbound', name: string, stale = true) => {
    const file = saveMedia(home, bucket, name, Buffer.from(name)); if (stale) utimesSync(file.path, old, old); return file;
  };
  const unused = file('outbound', 'unused'), sent = file('outbound', 'sent'), recent = file('inbound', 'recent', false);
  const session = file('inbound', 'session'), pending = file('outbound', 'pending');
  store.state.sessions['claude:/project'] = 'session';
  store.state.outbox.push({ id: 'pending', text: '', file: pending }); store.save();
  const before = readFileSync(store.path, 'utf8'), names = readdirSync(home);
  const preview = cleanMedia(home);
  assert.match(preview, /预览：2 个/); assert.ok(preview.includes(unused.path)); assert.ok(preview.includes(sent.path));
  assert.deepEqual(readdirSync(home), names); assert.equal(readFileSync(store.path, 'utf8'), before);
  const release = acquireLock(home);
  assert.throws(() => cleanMedia(home, { apply: true }), /已在运行/); assert.ok(existsSync(unused.path)); release();
  const report = cleanMedia(home, { apply: true }); assert.match(report, /已清理：2 个/);
  assert.ok(!existsSync(unused.path)); assert.ok(!existsSync(sent.path));
  for (const file of [recent, session, pending]) assert.ok(existsSync(file.path));
  assert.equal(mediaUsage(home).count, 3); assert.equal(readFileSync(store.path, 'utf8'), before);
  assert.throws(() => cleanMedia(home, { days: 0 }), /正整数/);
  writeFileSync(store.path, '{broken'); assert.throws(() => cleanMedia(home, { apply: true }), /无法读取/);
  assert.ok(existsSync(pending.path)); assert.ok(!existsSync(join(home, 'wcode.lock')));
});

test('sessions protect inbound references; pending inputs protect all media; symlinks are not followed', t => {
  const { home, store } = setup(t), old = new Date(Date.now() - 40 * 86_400_000);
  const inbound = saveMedia(home, 'inbound', 'old.txt', Buffer.from('old')), outbound = saveMedia(home, 'outbound', 'old.txt', Buffer.from('old'));
  for (const file of [inbound, outbound]) utimesSync(file.path, old, old);
  store.state.sessions['claude:/old'] = 'old'; store.save();
  assert.match(cleanMedia(home), /预览：1 个/); assert.match(cleanMedia(home), /会话仍存在/);
  const restored = new Store(home, initialState('claude', home)); restored.state.pendingInputs = [{ text: 'pending', attachments: [] }]; restored.save();
  assert.match(cleanMedia(home, { apply: true }), /已清理：0 个/);
  restored.state.pendingInputs = []; restored.save();
  restored.state.task = { status: 'interrupted', agent: 'claude', cwd: home, inputs: [{ text: 'unfinished', attachments: [] }] }; restored.save();
  assert.match(cleanMedia(home, { apply: true }), /已清理：0 个/); assert.match(cleanMedia(home), /未完成输入/);
  restored.state.task = { ...restored.state.task, status: 'succeeded' }; restored.save();
  const external = join(home, 'external.txt'); writeFileSync(external, 'external');
  symlinkSync(external, join(home, 'media', 'outbound', 'link'));
  cleanMedia(home, { apply: true }); assert.ok(existsSync(external)); assert.ok(existsSync(join(home, 'media', 'outbound', 'link')));
  assert.ok(existsSync(inbound.path)); assert.ok(!existsSync(outbound.path));
});

test('log rotation bounds backups, retains recent bytes and keeps an existing launchd-style descriptor usable', t => {
  const { home } = setup(t), dir = join(home, 'logs'); mkdirSync(dir);
  const path = join(dir, 'stderr.log'); writeFileSync(path, '0123456789abcdef', { mode: 0o644 });
  const fd = openSync(path, 'a');
  try {
    assert.equal(rotateLog(path, 8), true); assert.equal(readFileSync(path + '.1', 'utf8'), '89abcdef');
    assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(path + '.1').mode & 0o777, 0o600);
    writeSync(fd, 'after'); assert.equal(readFileSync(path, 'utf8'), 'after'); assert.equal(rotateLog(path, 8), false);
    for (let i = 0; i < 5; i++) { writeSync(fd, '123456789'); rotateLog(path, 8); }
    assert.equal(readdirSync(dir).length, LOG_BACKUPS + 1);
    writeSync(fd, 'last'); assert.equal(readFileSync(path, 'utf8'), 'last');
  } finally { closeSync(fd); }
  const target = join(home, 'outside'); writeFileSync(target, 'do not truncate');
  symlinkSync(target, join(dir, 'link.log')); assert.throws(() => rotateLog(join(dir, 'link.log'), 1));
  assert.equal(readFileSync(target, 'utf8'), 'do not truncate');
});

test('CLI reports the package version, diagnoses missing setup with exit 1 and keeps clean default read-only', t => {
  const { home } = setup(t), cli = new URL('../src/cli.ts', import.meta.url).pathname;
  const env = { ...process.env, WCODE_HOME: join(home, 'missing') };
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', env });
  assert.equal(version.status, 0); assert.equal(version.stdout.trim(), VERSION);
  const doctor = spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8', env });
  assert.equal(doctor.status, 1); assert.match(doctor.stdout, /登录凭据/); assert.ok(!existsSync(env.WCODE_HOME));
  const clean = spawnSync(process.execPath, [cli, 'clean'], { encoding: 'utf8', env });
  assert.equal(clean.status, 0); assert.match(clean.stdout, /预览：0 个/); assert.ok(!existsSync(env.WCODE_HOME));
  const invalid = spawnSync(process.execPath, [cli, 'clean', '--days', '0', '--apply'], { encoding: 'utf8', env });
  assert.equal(invalid.status, 1); assert.ok(!existsSync(env.WCODE_HOME));
  saveMedia(env.WCODE_HOME, 'outbound', 'orphan.txt', Buffer.from('orphan'));
  const missingState = spawnSync(process.execPath, [cli, 'clean', '--apply'], { encoding: 'utf8', env });
  assert.equal(missingState.status, 1); assert.match(missingState.stderr, /缺少 state/);
});
