import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Store } from './store.ts';
import type { Ilink } from './wechat/ilink.ts';
import { expired } from './wechat/ilink.ts';

export function splitReply(raw: string, limit = 2_000): string[] {
  let text = raw.replace(/!\[[^\]]*\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '')
    .replace(/!\[[^\]]*\](?:\[[^\]]*\])?/g, '').trim();
  if (!text) text = '任务已结束，没有文本输出。';
  if (text.length <= limit) return [text];
  const parts: string[] = [], size = limit - 96; // Reserve numbering and /more hint within the wire limit.
  if (size < 1) throw new Error('回复长度限制过小');
  while (text.length) {
    let end = Math.min(size, text.length);
    if (end < text.length) {
      const window = text.slice(0, end + 1);
      const boundary = window.lastIndexOf('\n\n') > 0 ? window.lastIndexOf('\n\n') : window.lastIndexOf('\n');
      if (boundary > 0) end = boundary;
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    parts.push(text.slice(0, end)); text = text.slice(end).replace(/^\n+/, '');
  }
  return parts.map((part, i) => `（${i + 1}/${parts.length}）\n${part}`);
}
export class Replies {
  store: Store; api: Pick<Ilink, 'send'>; signal: AbortSignal; onError: (e: unknown, fatal?: boolean) => void;
  pending?: Promise<void>; blocked = false; retryMs: number; generation = 0;
  constructor(store: Store, api: Pick<Ilink, 'send'>, signal: AbortSignal, onError: (e: unknown, fatal?: boolean) => void, retryMs = 2_000) {
    this.store = store; this.api = api; this.signal = signal; this.onError = onError; this.retryMs = retryMs;
  }
  clearPages(): void { this.store.state.pages = []; this.store.save(); }
  result(text: string): void { this.store.state.pages = splitReply(text); this.more(); }
  more(): void {
    const state = this.store.state;
    if (!state.pages.length) { this.send('没有更多内容。'); return; }
    const page = state.pages.splice(0, 3);
    if (state.pages.length) page[page.length - 1] += `\n还有 ${state.pages.length} 段，发送 /more`;
    this.enqueue(page);
  }
  send(text: string): void {
    const parts = splitReply(text);
    if (parts.length > 3) { this.store.state.pages = parts; this.more(); }
    else this.enqueue(parts);
  }
  enqueue(texts: string[]): void {
    this.store.state.outbox.push(...texts.map(text => ({ id: `wcode-${randomUUID()}`, text })));
    this.store.save(); this.flush();
  }
  resume(): void { this.generation++; this.blocked = false; this.flush(); }
  flush(): void {
    if (this.pending || this.blocked || this.signal.aborted) return;
    this.pending = this.drain().catch(e => {
      this.blocked = true;
      if (!this.signal.aborted) this.onError(e, true);
    }).finally(() => {
      this.pending = undefined;
      if (this.store.state.outbox.length && this.store.state.contextToken) this.flush();
    });
  }
  async drain(): Promise<void> {
    const state = this.store.state;
    while (state.outbox.length && state.contextToken && !this.signal.aborted) {
      const message = state.outbox[0];
      for (let attempt = 0; ; attempt++) {
        const generation = this.generation;
        try { await this.api.send(message.text, state.contextToken, message.id, this.signal); break; }
        catch (e) {
          // An owner message may arrive while the final attempt is still in flight.
          if (!expired(e) && !this.signal.aborted && attempt === 3 && generation !== this.generation) { attempt = -1; continue; }
          if (expired(e) || attempt === 3 || this.signal.aborted) { this.blocked = true; if (!this.signal.aborted) this.onError(e); return; }
          await sleep(this.retryMs * 2 ** attempt, undefined, { signal: this.signal });
        }
      }
      state.outbox.shift(); this.store.save();
    }
  }
}
