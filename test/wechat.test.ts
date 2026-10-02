import test from 'node:test';
import assert from 'node:assert/strict';
import { Ilink, IlinkError, trustedBase } from '../src/wechat/ilink.ts';
import { inbound } from '../src/wechat/inbound.ts';
import { login } from '../src/wechat/login.ts';
import { auth, eventually, message } from './helpers.ts';
import { VERSION } from '../src/config.ts';

test('owner filtering, text/voice/quote extraction and command text isolation', () => {
  for (const bad of [{ ...message('x'), from_user_id: 'other' }, { ...message('x'), message_type: 2 }, { ...message('x'), group_id: 'group' }, null])
    assert.equal(inbound(bad, 'owner'), undefined);
  const input = inbound({ ...message(''), item_list: [
    { voice_item: { text: '语音内容' }, ref_msg: { message_item: { text_item: { text: '/stop 引用内容' } } } },
    { text_item: { text: '补充文本' } },
  ] }, 'owner')!;
  assert.equal(input.commandText, '语音内容\n补充文本');
  assert.equal(input.text, '[引用]\n/stop 引用内容\n[/引用]\n语音内容\n补充文本');
  assert.equal(input.contextToken, 'context');
});
test('iLink wire headers, metadata, envelope, return codes, HTTP errors and cancellation', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  let response: object = { ret: 0 }, status = 200;
  const api = new Ilink(auth, (async (url, init) => {
    requests.push({ url: String(url), init: init! }); return new Response(JSON.stringify(response), { status });
  }) as typeof fetch);
  await api.send('hello\n世界', 'latest-context', 'stable-client-id');
  const { url, init } = requests[0], headers = new Headers(init.headers), body = JSON.parse(String(init.body));
  assert.ok(url.endsWith('/ilink/bot/sendmessage')); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
  assert.equal(headers.get('Authorization'), 'Bearer test-token'); assert.equal(headers.get('AuthorizationType'), 'ilink_bot_token');
  assert.equal(headers.get('iLink-App-Id'), 'bot');
  const [major, minor, patch] = VERSION.split('.').map(Number);
  assert.equal(headers.get('iLink-App-ClientVersion'), String((major << 16) | (minor << 8) | patch));
  const uin = Buffer.from(headers.get('X-WECHAT-UIN')!, 'base64').toString(); assert.match(uin, /^\d+$/); assert.ok(Number(uin) <= 0xffffffff);
  assert.equal(body.base_info.bot_agent, `wcode/${VERSION}`); assert.equal(body.msg.to_user_id, 'owner');
  assert.equal(body.msg.context_token, 'latest-context'); assert.equal(body.msg.client_id, 'stable-client-id');
  assert.equal(body.msg.message_type, 2); assert.equal(body.msg.message_state, 2);
  assert.deepEqual(body.msg.item_list, [{ type: 1, text_item: { text: 'hello\n世界' } }]);
  response = { errcode: -14 }; await assert.rejects(api.updates('cursor', new AbortController().signal), e => e instanceof IlinkError && e.code === -14);
  response = { ret: -14, errcode: -1 }; await assert.rejects(api.request('getconfig', {}), e => e instanceof IlinkError && e.code === -14);
  response = { ret: 2 }; await assert.rejects(api.send('x', 'c', 'i'), /错误 2/);
  status = 503; await assert.rejects(api.send('x', 'c', 'i'), /HTTP 503/);
  const timeout = new Ilink(auth, (async () => { throw new DOMException('timeout', 'TimeoutError'); }) as typeof fetch);
  assert.deepEqual(await timeout.updates('cursor', new AbortController().signal), {});
  await assert.rejects(timeout.updates('cursor', AbortSignal.abort()));
  const bodyTimeout = new Ilink(auth, (async () => { throw new DOMException('body timed out', 'AbortError'); }) as typeof fetch);
  assert.deepEqual(await bodyTimeout.updates('cursor', new AbortController().signal), {});
});
test('typing sends correct ticket and always cancels after abort', async () => {
  const bodies: Record<string, unknown>[] = [], controller = new AbortController();
  const api = new Ilink(auth, (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    return Response.json({ ret: 0, typing_ticket: 'ticket' });
  }) as typeof fetch);
  const done = api.typing('context', controller.signal);
  await eventually(() => bodies.length === 2); controller.abort(); await done;
  assert.equal(bodies[0].ilink_user_id, 'owner'); assert.equal(bodies[0].context_token, 'context');
  assert.deepEqual(bodies.slice(1).map(b => [b.status, b.typing_ticket, b.ilink_user_id]), [[1, 'ticket', 'owner'], [2, 'ticket', 'owner']]);
});
test('QR login handles verification code, trusted redirect and confirmed identity', async () => {
  const requests: URL[] = [], shown: string[] = [];
  const states = [
    { status: 'need_verifycode' },
    { status: 'scaned_but_redirect', redirect_host: 'ilink-test.weixin.qq.com' },
    { status: 'confirmed', bot_token: 'new-token', ilink_bot_id: 'new-bot', ilink_user_id: 'new-owner', baseurl: 'https://ilink-test.weixin.qq.com' },
  ];
  const api = new Ilink({}, (async (url, init) => {
    const parsed = new URL(String(url)); requests.push(parsed);
    if (parsed.pathname.endsWith('get_bot_qrcode')) {
      assert.equal(init?.method, 'POST'); assert.equal(parsed.searchParams.get('bot_type'), '3');
      return Response.json({ qrcode: 'qr&value', qrcode_img_content: 'https://qr.example.test' });
    }
    return Response.json(states.shift());
  }) as typeof fetch);
  const result = await login(new AbortController().signal, { show: text => shown.push(text), code: async () => '123456' }, api);
  assert.equal(result.ownerId, 'new-owner'); assert.equal(result.token, 'new-token'); assert.equal(shown.length, 1);
  assert.equal(requests[1].searchParams.get('qrcode'), 'qr&value');
  assert.equal(requests[2].searchParams.get('verify_code'), '123456');
  assert.equal(requests[3].hostname, 'ilink-test.weixin.qq.com');
});
test('login rejects incomplete identities, blocked verification and untrusted redirects', async () => {
  for (const state of [
    { status: 'confirmed', bot_token: 'x', ilink_bot_id: 'x' }, { status: 'verify_code_blocked' },
    { status: 'scaned_but_redirect', redirect_host: 'weixin.qq.com.attacker.test' },
  ]) {
    const api = new Ilink({}, (async url => Response.json(String(url).includes('get_bot_qrcode') ? { qrcode: 'x', qrcode_img_content: 'x' } : state)) as typeof fetch);
    await assert.rejects(login(new AbortController().signal, { show: () => {}, code: async () => '' }, api));
  }
  assert.throws(() => trustedBase('http://ilinkai.weixin.qq.com'));
  assert.throws(() => trustedBase('https://user:pass@ilinkai.weixin.qq.com'));
});
test('QR long-poll timeout is a wait state; externally cancelled login never retries', async () => {
  let polls = 0;
  const api = new Ilink({}, (async url => {
    if (String(url).includes('get_bot_qrcode')) return Response.json({ qrcode: 'q', qrcode_img_content: 'q' });
    if (++polls === 1) throw new DOMException('timeout', 'TimeoutError');
    return Response.json({ status: 'confirmed', bot_token: 't', ilink_bot_id: 'b', ilink_user_id: 'o' });
  }) as typeof fetch);
  await login(new AbortController().signal, { show: () => {}, code: async () => '' }, api);
  assert.equal(polls, 2);
  await assert.rejects(login(AbortSignal.abort(), { show: () => {}, code: async () => '' }, api));
  assert.equal(polls, 2);
});
