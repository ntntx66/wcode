// Explicit integration test: real configured agents; all message delivery stays on localhost.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { dataDir, isAgent, loadConfig, names } from '../src/config.ts';
import { record } from '../src/values.ts';
import { Store, initialState, sessionKey } from '../src/store.ts';
import { readJson } from '../src/json.ts';
import { Bot } from '../src/bot.ts';
import { Ilink } from '../src/wechat/ilink.ts';
import { run } from '../src/agents/run.ts';
import type { AgentEvent } from '../src/agents/types.ts';
import { returnedFiles } from '../src/files.ts';
import { splitReply } from '../src/reply.ts';
import { withCancellation } from './cancellation.ts';

await withCancellation(async signal => {
  const config = loadConfig(dataDir()), models = record(record(readJson(join(dataDir(), 'state.json'), {})).models);
  const selected = process.argv.slice(2).length ? process.argv.slice(2) : names;
  for (const name of selected) {
    signal.throwIfAborted();
    if (!isAgent(name)) throw new Error(`Unknown agent: ${name}`);
    const home = realpathSync(mkdtempSync(join(tmpdir(), `wcode-live-${name}-`)));
    const store = new Store(home, initialState(name, home));
    if (typeof models[name] === 'string') store.state.models[name] = models[name];
    const sent: string[] = [], events: AgentEvent[] = [];
    const server = createServer(async (req, res) => {
      let data = ''; for await (const chunk of req) data += chunk;
      const body = JSON.parse(data);
      if (req.url?.endsWith('/sendmessage')) {
        const text = body.msg.item_list[0]?.text_item?.text;
        assert.equal(typeof text, 'string'); sent.push(text);
        console.log(JSON.stringify({ agent: name, delivered: text }));
      }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ret: 0 }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const auth = { token: 'local-test', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, botId: 'local-bot', ownerId: 'local-owner' };
    let result = '', started = 0;
    const bot = new Bot(store, { ...config, turnTimeoutMinutes: 4 }, auth, new Ilink(auth), (spec, options) => run(spec, {
      ...options, onEvent: event => { events.push(event); options.onEvent(event); },
    }).then(text => { result = text; return text; }));
    const stop = () => bot.controller.abort(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    try {
      let session: string | undefined;
      for (const [index, prompt] of [
        '这是一个本地输出协议测试。先用一句简短中文说明你准备检查当前目录，然后用 shell 工具执行 pwd；再用一句中文说明你将打印探针，再用 shell 工具执行 printf wcode-live-ok。最后仅回复 WCODE_LIVE_OK。不要修改文件、不要联网。',
        '这是续接验证：请用 shell 工具执行 printf wcode-resume-ok，最后仅回复 WCODE_RESUME_OK。不要修改文件、不要联网。',
      ].entries()) {
        events.length = 0; sent.length = 0; started = Date.now();
        bot.accept({ get_updates_buf: String(index + 1), msgs: [{ message_type: 1, from_user_id: auth.ownerId,
          context_token: 'local-context', item_list: [{ type: 1, text_item: { text: prompt } }] }] });
        await bot.active?.done;
        const deadline = Date.now() + 5000;
        while (bot.replies.pending && Date.now() < deadline) await sleep(10);
        assert.equal(bot.replies.pending, undefined); assert.equal(bot.failure, undefined);
        assert.equal(store.state.task?.status, 'succeeded'); assert.equal(store.state.outbox.length, 0);
        assert.equal(result.trim(), index ? 'WCODE_RESUME_OK' : 'WCODE_LIVE_OK');
        const texts = events.filter(event => event.type === 'text').map(event => event.text);
        assert.ok(events.some(event => event.type === 'tool'));
        if (!index) assert.ok(texts.length >= 3, 'expected two explanations and the final answer');
        assert.deepEqual(sent, texts.flatMap(text => splitReply(returnedFiles(text).text)));
        assert.equal(sent.filter(text => text === result.trim()).length, 1);
        if (session) assert.equal(store.state.sessions[sessionKey(store.state)], session);
        session = store.state.sessions[sessionKey(store.state)]; assert.ok(session);
        console.log(JSON.stringify({ agent: name, round: index ? 'resume' : 'new', status: 'OK', messages: sent.length, seconds: (Date.now() - started) / 1000 }));
      }
    } finally {
      bot.controller.abort(); await bot.active?.done; await bot.replies.pending;
      signal.removeEventListener('abort', stop);
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  }
});
