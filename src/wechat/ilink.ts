// Protocol adapted from @tencent-weixin/openclaw-weixin 2.4.9 (MIT); see THIRD_PARTY_NOTICES.md.
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { record, VERSION } from '../config.ts';
import type { Auth } from '../store.ts';
import type { LocalFile } from '../files.ts';
import { upload } from './media.ts';
import type { FileItem } from './media.ts';

export const BASE_URL = 'https://ilinkai.weixin.qq.com';
export class IlinkError extends Error {
  code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
export const expired = (e: unknown) => e instanceof IlinkError && e.code === -14;
export type Updates = { msgs?: unknown[]; get_updates_buf?: string; longpolling_timeout_ms?: number };
export function trustedBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.username || url.password || url.port)
    throw new Error('iLink 返回了不可信的服务地址');
  return url.origin;
}
export class Ilink {
  auth: Partial<Auth>;
  fetcher: typeof fetch;
  constructor(auth: Partial<Auth> = {}, fetcher = fetch) { this.auth = auth; this.fetcher = fetcher; }
  async request<T>(endpoint: string, body?: object, signal?: AbortSignal, timeout = 15_000): Promise<T> {
    const [major, minor, patch] = VERSION.split('.').map(Number);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
      'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((major << 16) | (minor << 8) | patch),
    };
    if (this.auth.token) headers.Authorization = `Bearer ${this.auth.token}`;
    const response = await this.fetcher(new URL(`ilink/bot/${endpoint}`, `${this.auth.baseUrl ?? BASE_URL}/`), {
      method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error',
      body: body === undefined ? undefined : JSON.stringify({ ...body, base_info: { channel_version: VERSION, bot_agent: `wcode/${VERSION}` } }),
      signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new IlinkError(response.status, `iLink HTTP ${response.status}`);
    const data: unknown = await response.json(), o = record(data);
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('iLink 响应不是对象');
    const code = o.errcode === -14 || o.ret === -14 ? -14 : Number(o.errcode || o.ret || 0);
    if (code) throw new IlinkError(code, code === -14 ? '微信 token 已失效，请重新执行 wcode login' : `iLink 错误 ${code}`);
    return data as T;
  }
  async updates(cursor: string, signal: AbortSignal, timeout = 35_000): Promise<Updates> {
    try { return await this.request('getupdates', { get_updates_buf: cursor }, signal, timeout); }
    catch (e) { if (!signal.aborted && e instanceof Error && ['TimeoutError', 'AbortError'].includes(e.name)) return {}; throw e; }
  }
  send(text: string, contextToken: string, id: string, signal?: AbortSignal): Promise<unknown> {
    return this.sendItem({ type: 1, text_item: { text } }, contextToken, id, signal);
  }
  uploadFile(file: LocalFile, signal?: AbortSignal): Promise<FileItem> { return upload(file, this, signal); }
  sendFile(item: FileItem, contextToken: string, id: string, signal?: AbortSignal): Promise<unknown> {
    return this.sendItem(item, contextToken, id, signal);
  }
  private sendItem(item: object, contextToken: string, id: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('sendmessage', { msg: {
      from_user_id: '', to_user_id: this.auth.ownerId, client_id: id, message_type: 2, message_state: 2,
      context_token: contextToken, item_list: [item],
    } }, signal);
  }
  async typing(contextToken: string, signal: AbortSignal): Promise<void> {
    let ticket: string | undefined;
    try {
      const config = await this.request<{ typing_ticket?: string }>('getconfig', {
        ilink_user_id: this.auth.ownerId, context_token: contextToken,
      }, signal, 10_000);
      ticket = config.typing_ticket;
      if (!ticket) return;
      while (!signal.aborted) {
        await this.request('sendtyping', { ilink_user_id: this.auth.ownerId, typing_ticket: ticket, status: 1 }, signal, 10_000);
        await sleep(5_000, undefined, { signal });
      }
    } catch (e) { if (!signal.aborted) throw e; }
    finally {
      if (ticket) await this.request('sendtyping', { ilink_user_id: this.auth.ownerId, typing_ticket: ticket, status: 2 }, undefined, 3_000);
    }
  }
}
