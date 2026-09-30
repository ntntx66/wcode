import { createInterface } from 'node:readline/promises';
import qr from 'qrcode-terminal';
import { setTimeout as sleep } from 'node:timers/promises';
import { Ilink, BASE_URL, trustedBase } from './ilink.ts';
import type { Auth } from '../store.ts';

type QR = { qrcode: string; qrcode_img_content: string };
type Status = { status: string; bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string; redirect_host?: string };
export async function login(signal: AbortSignal, io = {
  show: (text: string) => { console.log('请用微信扫码：'); qr.generate(text, { small: true }); console.log(text); },
  code: async (signal: AbortSignal) => {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await input.question('输入手机微信显示的数字：', { signal })).trim(); } finally { input.close(); }
  },
}, api = new Ilink()): Promise<Auth> {
  let code: string | undefined, refreshes = 0, failures = 0;
  const flow = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]);
  const getQR = async () => {
    api.auth.baseUrl = BASE_URL;
    const value = await api.request<QR>('get_bot_qrcode?bot_type=3', { local_token_list: [] }, flow);
    if (!value.qrcode || !value.qrcode_img_content) throw new Error('iLink 未返回二维码');
    io.show(value.qrcode_img_content); return value.qrcode;
  };
  let qrcode = await getQR();
  while (true) {
    flow.throwIfAborted();
    let s: Status;
    try {
      s = await api.request<Status>(`get_qrcode_status?${new URLSearchParams({ qrcode, ...(code ? { verify_code: code } : {}) })}`, undefined, flow, 35_000);
      failures = 0;
    } catch (e) {
      flow.throwIfAborted();
      if (e instanceof Error && ['TimeoutError', 'AbortError'].includes(e.name)) s = { status: 'wait' };
      else {
        if (++failures >= 5) throw e;
        await sleep(Math.min(2 ** failures * 1_000, 30_000), undefined, { signal: flow }); continue;
      }
    }
    switch (s.status) {
      case 'confirmed':
        if (!s.bot_token || !s.ilink_bot_id || !s.ilink_user_id) throw new Error('登录响应缺少 token、botId 或 ownerId');
        return { token: s.bot_token, botId: s.ilink_bot_id, ownerId: s.ilink_user_id, baseUrl: trustedBase(s.baseurl ?? api.auth.baseUrl ?? BASE_URL) };
      case 'scaned': code = undefined; break;
      case 'need_verifycode': code = await io.code(flow); continue;
      case 'scaned_but_redirect':
        if (!s.redirect_host) throw new Error('扫码跳转缺少 redirect_host');
        api.auth.baseUrl = trustedBase(`https://${s.redirect_host}`); break;
      case 'expired':
        if (++refreshes > 3) throw new Error('二维码多次过期，请重新执行 wcode login');
        code = undefined; qrcode = await getQR(); break;
      case 'verify_code_blocked': throw new Error('验证码被锁定，请稍后重试');
      case 'binded_redirect': throw new Error('此 bot 已绑定其他客户端，请在微信重新选择连接');
      case 'wait': break;
      default: throw new Error(`未知扫码状态：${s.status}`);
    }
    await sleep(1_000, undefined, { signal: flow });
  }
}
