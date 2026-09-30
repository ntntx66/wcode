import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Bot } from '../src/bot.ts';
import { Ilink } from '../src/wechat/ilink.ts';
import { download } from '../src/wechat/media.ts';
import { auth, eventually, message, setup } from './helpers.ts';

test('HTTP encrypted file → real text CLI → new file → encrypted upload → file message', { timeout: 10_000 }, async t => {
  const { home, store, config } = setup(t), raw = Buffer.from('M2_FILE_INPUT'), key = Buffer.alloc(16, 7);
  const cipher = createCipheriv('aes-128-ecb', key, null), encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
  let first = true, outgoingKey = Buffer.alloc(0), uploaded = '', delivered = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.url?.startsWith('/c2c/download')) { res.end(encrypted); return; }
    if (req.url?.startsWith('/c2c/upload')) {
      const decipher = createDecipheriv('aes-128-ecb', outgoingKey, null);
      uploaded = Buffer.concat([decipher.update(body), decipher.final()]).toString();
      res.setHeader('x-encrypted-param', 'outgoing-download'); res.end(); return;
    }
    const json = JSON.parse(body.toString());
    if (req.url?.endsWith('/getupdates')) {
      if (first) { first = false; res.end(JSON.stringify({ get_updates_buf: '1', msgs: [{ ...message(''), item_list: [{ type: 4, file_item: { file_name: 'data.txt', len: String(raw.length), media: { encrypt_query_param: 'inbound', aes_key: key.toString('base64') } } }] }] })); }
      return;
    }
    if (req.url?.endsWith('/getuploadurl')) { outgoingKey = Buffer.from(json.aeskey, 'hex'); res.end(JSON.stringify({ upload_param: 'upload' })); return; }
    if (req.url?.endsWith('/sendmessage') && json.msg.item_list[0].type === 4) {
      const file = json.msg.item_list[0].file_item;
      assert.equal(file.file_name, 'output.txt'); assert.equal(file.media.encrypt_query_param, 'outgoing-download');
      assert.equal(file.len, String(Buffer.byteLength(uploaded))); delivered = true;
    }
    res.end(JSON.stringify({ ret: 0 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetcher: typeof fetch = (url, init) => { const original = new URL(String(url)); return fetch(base + original.pathname + original.search, init); };
  const script = join(home, 'agent.cjs');
  writeFileSync(script, `const fs=require('node:fs'), path=require('node:path');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{
    const file=JSON.parse(prompt.match(/文件：(\"[^\\n]+\")/)[1]);
    const output=path.join(process.cwd(),'output.txt');fs.writeFileSync(output,fs.readFileSync(file,'utf8')+'_M3_OUTPUT');
    console.log('done\\nWCODE_FILE: '+output);
  });`);
  config.agents.local = { type: 'text', command: process.execPath, args: [script], extraArgs: [] }; store.state.agent = 'local';
  const controller = new AbortController(), bot = new Bot(store, config, auth, new Ilink(auth, fetcher));
  bot.download = (attachment, home, signal) => download(attachment, home, signal, fetcher);
  const running = bot.start(controller.signal);
  t.after(async () => { controller.abort(); await running; });
  await eventually(() => delivered && !store.state.outbox.length, 5_000);
  assert.equal(uploaded, 'M2_FILE_INPUT_M3_OUTPUT');
  controller.abort(); await running;
});
