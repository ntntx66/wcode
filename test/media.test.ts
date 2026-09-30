import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aesKey, cdnUrl, download, upload } from '../src/wechat/media.ts';
import type { FileItem } from '../src/wechat/media.ts';
import { Ilink } from '../src/wechat/ilink.ts';
import { inbound } from '../src/wechat/inbound.ts';
import { MAX_MEDIA_BYTES, readLocalFile, returnedFiles, safeName, snapshotFile } from '../src/files.ts';
import { Store, initialState } from '../src/store.ts';
import { Replies } from '../src/reply.ts';
import { auth, eventually, message, setup } from './helpers.ts';

const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN8sAAAAASUVORK5CYII=', 'base64');
const encrypt = (data: Buffer) => { const cipher = createCipheriv('aes-128-ecb', key, null); return Buffer.concat([cipher.update(data), cipher.final()]); };
const ref = { encrypt_query_param: 'param +/&', aes_key: key.toString('base64') };
const item: FileItem = { type: 4, file_item: { file_name: 'result.txt', len: '5', media: { ...ref, encrypt_type: 1 } } };

test('all official key encodings, plain images, full URL preference, filenames and private storage', async t => {
  const { home } = setup(t);
  for (const encoding of [key.toString('base64'), Buffer.from(key.toString('hex')).toString('base64')]) assert.deepEqual(aesKey(encoding), key);
  assert.throws(() => aesKey('bad'), /密钥/);
  for (const raw of [false, true, 'plain']) {
    const result = await download({ kind: 'image', item: { media: { ...ref, aes_key: raw === 'plain' ? undefined : ref.aes_key }, ...(raw === true ? { aeskey: key.toString('hex') } : {}) } }, home, new AbortController().signal, (async (url, init) => {
      assert.equal(new URL(String(url)).searchParams.get('encrypted_query_param'), ref.encrypt_query_param);
      assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).get('Authorization'), null);
      return new Response(raw === 'plain' ? png : encrypt(png));
    }) as typeof fetch);
    assert.deepEqual(readFileSync(result.path), png); assert.match(result.path, /\.png$/); assert.equal(statSync(result.path).mode & 0o777, 0o600);
  }
  const body = Buffer.from('文件内容');
  const result = await download({ kind: 'file', item: { file_name: '../../目录/报告.txt', len: String(body.length), md5: createHash('md5').update(body).digest('hex'), media: { ...ref, full_url: 'https://novac2c.cdn.weixin.qq.com/full', aes_key: Buffer.from(key.toString('hex')).toString('base64') } } }, home, new AbortController().signal, (async url => {
    assert.equal(String(url), 'https://novac2c.cdn.weixin.qq.com/full'); return new Response(encrypt(body));
  }) as typeof fetch);
  assert.equal(result.name, '报告.txt'); assert.ok(result.path.startsWith(join(home, 'media', 'inbound'))); assert.deepEqual(readFileSync(result.path), body);
  const longName = safeName('中文'.repeat(200) + '.txt'); assert.ok(Buffer.byteLength(longName) <= 180); assert.ok(longName.endsWith('.txt'));
});

test('media rejects untrusted hosts, malformed crypto, incorrect length/hash, overflow and cancellation', async t => {
  const { home } = setup(t), signal = new AbortController().signal;
  for (const url of ['https://weixin.qq.com.evil.test/x', 'http://novac2c.cdn.weixin.qq.com/x', 'https://user@novac2c.cdn.weixin.qq.com/x', 'https://127.0.0.1/x']) assert.throws(() => cdnUrl(url));
  const attachment = { kind: 'file' as const, item: { media: ref } };
  for (const extra of [{ len: '99' }, { md5: 'bad' }]) await assert.rejects(download({ ...attachment, item: { ...attachment.item, ...extra } }, home, signal, (async () => new Response(encrypt(png))) as typeof fetch), /不符/);
  await assert.rejects(download(attachment, home, signal, (async () => new Response('broken')) as typeof fetch), /解密/);
  await assert.rejects(download(attachment, home, signal, (async () => new Response('', { headers: { 'content-length': String(MAX_MEDIA_BYTES + 17) } })) as typeof fetch), /100 MiB/);
  const chunks = new ReadableStream({ start(controller) { for (let i = 0; i < 101; i++) controller.enqueue(new Uint8Array(1024 * 1024)); controller.close(); } });
  await assert.rejects(download(attachment, home, signal, (async () => new Response(chunks)) as typeof fetch), /100 MiB/);
  await assert.rejects(download(attachment, home, AbortSignal.abort(new Error('cancelled')), (async () => { assert.fail('must not fetch'); }) as typeof fetch), /cancelled/);
  await assert.rejects(download({ kind: 'image', item: { media: ref, aeskey: 'xyz' } }, home, signal), /密钥/);
});

test('owner-filtered images, files and quoted attachments retain command isolation', () => {
  const msg = { ...message('analyze'), item_list: [{ type: 2, image_item: { media: ref } }, { type: 1, text_item: { text: 'analyze' }, ref_msg: { message_item: item } }] };
  assert.equal(inbound({ ...msg, from_user_id: 'other' }, 'owner'), undefined);
  const input = inbound(msg, 'owner')!;
  assert.equal(input.commandText, 'analyze'); assert.deepEqual(input.attachments.map(a => a.kind), ['image', 'file']);
});

test('upload uses correct MD5, padded length, AES ECB ciphertext, CDN headers and file envelope', async t => {
  const { home } = setup(t), path = join(home, '报告.txt'); writeFileSync(path, 'hello');
  const file = snapshotFile(home, path, home); writeFileSync(path, 'changed later');
  let request: Record<string, unknown> = {}, sent: Record<string, unknown> = {};
  for (const full of [false, true]) {
    const api = new Ilink(auth, (async (url, init) => {
      if (String(url).includes('getuploadurl')) {
        request = JSON.parse(String(init?.body));
        assert.equal(request.rawfilemd5, '5d41402abc4b2a76b9719d911017c592'); assert.equal(request.filesize, 16); assert.equal(request.rawsize, 5);
        assert.equal(request.media_type, 3); assert.equal(request.no_need_thumb, true); assert.equal(request.to_user_id, 'owner');
        return Response.json(full ? { upload_full_url: 'https://novac2c.cdn.weixin.qq.com/full' } : { upload_param: 'upload+/' });
      }
      if (String(url).includes('sendmessage')) { sent = JSON.parse(String(init?.body)).msg; return Response.json({ ret: 0 }); }
      assert.equal(new Headers(init?.headers).get('Authorization'), null); assert.equal(init?.redirect, 'error');
      assert.equal(new URL(String(url)).pathname, full ? '/full' : '/c2c/upload');
      const decipher = createDecipheriv('aes-128-ecb', Buffer.from(String(request.aeskey), 'hex'), null);
      assert.equal(Buffer.concat([decipher.update(Buffer.from(init!.body as Uint8Array)), decipher.final()]).toString(), 'hello');
      return new Response('', { headers: { 'x-encrypted-param': 'download-ref' } });
    }) as typeof fetch);
    const uploaded = await upload(file, api); await api.sendFile(uploaded, 'latest', 'stable');
    assert.equal(uploaded.file_item.len, '5'); assert.equal(uploaded.file_item.file_name, '报告.txt');
    assert.deepEqual(aesKey(uploaded.file_item.media.aes_key), Buffer.from(String(request.aeskey), 'hex'));
    assert.equal(sent.client_id, 'stable'); assert.equal(sent.context_token, 'latest'); assert.deepEqual(sent.item_list, [uploaded]);
  }
  writeFileSync(file.path, 'tampered'); await assert.rejects(upload(file, new Ilink(auth)), /快照/);
  assert.throws(() => readLocalFile(home), /普通文件/);
});

test('file outbox survives restart, avoids reupload, preserves bytes and resumes in order with fresh context', async t => {
  const { home, store } = setup(t), path = join(home, 'source.txt'); writeFileSync(path, 'hello'); store.state.contextToken = 'old';
  let uploads = 0, sends = 0;
  const replies = new Replies(store, { send: async () => {}, uploadFile: async file => {
    uploads++; assert.equal(readFileSync(file.path, 'utf8'), 'hello'); return item;
  }, sendFile: async () => { sends++; throw new Error('temporary send error'); } }, new AbortController().signal, () => {}, 1);
  replies.file(path, home); writeFileSync(path, 'modified'); await eventually(() => !replies.pending);
  assert.equal(uploads, 1); assert.equal(sends, 4); assert.equal(store.state.outbox.length, 1);
  const id = store.state.outbox[0].id, restored = new Store(home, initialState('pi', home)), order: string[] = [];
  restored.state.contextToken = 'fresh';
  const retry = new Replies(restored, { send: async text => { order.push(text); }, uploadFile: async () => assert.fail('must reuse uploaded media'), sendFile: async (media, token, actualId) => {
    assert.deepEqual(media, item); assert.equal(token, 'fresh'); assert.equal(actualId, id); order.push('file');
  } }, new AbortController().signal, assert.fail);
  retry.send('next'); await eventually(() => !retry.pending);
  assert.deepEqual(order, ['file', 'next']); assert.equal(restored.state.outbox.length, 0);
});

test('agent file declarations require standalone absolute paths outside code fences', () => {
  assert.deepEqual(returnedFiles('done\nWCODE_FILE: /tmp/报告 a.txt\nWCODE_FILE: /tmp/报告 a.txt'), { text: 'done', paths: ['/tmp/报告 a.txt'] });
  assert.deepEqual(returnedFiles('```\nWCODE_FILE: /tmp/example\n```').paths, []);
  assert.deepEqual(returnedFiles('WCODE_FILE: relative/path').paths, []);
});

test('upload persistence failure stops before file delivery; failed uploads retain the snapshot', async t => {
  const { home, store } = setup(t), path = join(home, 'source.txt'); writeFileSync(path, 'hello'); store.state.contextToken = 'context';
  let fatal = false, sent = false;
  const replies = new Replies(store, { send: async () => {}, uploadFile: async () => {
    store.save = () => { throw new Error('disk full'); }; return item;
  }, sendFile: async () => { sent = true; } }, new AbortController().signal, (_error, isFatal) => { fatal = !!isFatal; }, 1);
  replies.file(path, home); await eventually(() => !replies.pending);
  assert.ok(fatal); assert.equal(sent, false); assert.equal(store.state.outbox.length, 1);
  const restored = new Store(home, initialState('claude', home)); let uploads = 0;
  const retry = new Replies(restored, { send: async () => {}, uploadFile: async () => { uploads++; throw new Error('offline'); }, sendFile: async () => assert.fail('upload has not succeeded') }, new AbortController().signal, () => {}, 1);
  retry.resume(); await eventually(() => !retry.pending);
  assert.equal(uploads, 4); assert.equal(restored.state.outbox.length, 1); assert.equal(restored.state.outbox[0].item, undefined);
});
