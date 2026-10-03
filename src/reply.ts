import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { State, Store } from './store.ts';
import type { Ilink } from './wechat/ilink.ts';
import { expired } from './wechat/ilink.ts';
import { returnedFiles, snapshotFile } from './files.ts';

type ReplyChannel = Pick<Ilink, 'send'> & Partial<Pick<Ilink, 'uploadFile' | 'sendFile'>>;
export type LiveText = { parts: { id: string; text: string; sent: boolean }[]; done: Promise<void> };
type PreparedReply = Pick<State, 'pages' | 'outbox'>;
const messages = (texts: string[]): State['outbox'] => texts.map(text => ({ id: `wcode-${randomUUID()}`, text }));

function firstPage(parts: string[], files: State['outbox'] = []): PreparedReply {
  const page = parts.slice(0, 3), pages = parts.slice(3);
  if (pages.length) page[page.length - 1] += `\n还有 ${pages.length} 段，发送 /more`;
  return { pages, outbox: [...messages(page), ...files] };
}

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
  store: Store; api: ReplyChannel; signal: AbortSignal; onError: (e: unknown, fatal?: boolean) => void;
  pending?: Promise<void>; blocked = false; retryMs: number; generation = 0;
  private liveQueue: { live: LiveText; signal: AbortSignal; resolve: () => void }[] = [];
  private sendingLive?: AbortController;
  constructor(store: Store, api: ReplyChannel, signal: AbortSignal, onError: (e: unknown, fatal?: boolean) => void, retryMs = 2_000) {
    this.store = store; this.api = api; this.signal = signal; this.onError = onError; this.retryMs = retryMs;
  }
  prepareResult(text: string, cwd?: string, live?: LiveText): PreparedReply {
    const files: State['outbox'] = [], notices: string[] = [];
    if (cwd) {
      const result = returnedFiles(text);
      text = result.text;
      if (result.paths.length > 3) notices.push('❌ 每轮最多回传 3 个文件，超出的请用 /send。');
      for (const path of result.paths.slice(0, 3)) {
        try { files.push({ id: `wcode-${randomUUID()}`, text: '', file: snapshotFile(this.store.home, path, cwd) }); }
        catch (e) { notices.push(`❌ 文件回传：${String(e instanceof Error ? e.message : e).slice(0, 500)}`); }
      }
      text = text.trim() || `已生成 ${files.length} 个文件。`;
    }
    const parts = splitReply(live ? text : [text, ...notices].join('\n'));
    if (live) {
      // Reuse acknowledgements and IDs from direct delivery, including a partially sent long answer.
      const missing = parts.flatMap((text, i) => {
        const previous = live.parts[i];
        if (previous?.text === text && previous.sent) return [];
        return [{ id: previous?.text === text ? previous.id : `wcode-${randomUUID()}`, text }];
      });
      const warnings = notices.flatMap(text => splitReply(text).map(text => ({ id: `wcode-${randomUUID()}`, text })));
      return { pages: [], outbox: [...missing, ...warnings, ...files] };
    }
    return firstPage(parts, files);
  }
  file(path: string, cwd: string): void {
    this.enqueue([{ id: `wcode-${randomUUID()}`, text: '', file: snapshotFile(this.store.home, path, cwd) }]);
  }
  more(): void {
    const state = this.store.state;
    if (!state.pages.length) { this.send('没有更多内容。'); return; }
    const next = firstPage(state.pages);
    state.pages = next.pages;
    this.enqueue(next.outbox);
  }
  send(text: string): void {
    const parts = splitReply(text);
    if (parts.length > 3) { this.store.state.pages = parts; this.more(); }
    else this.enqueue(messages(parts));
  }
  cancelLive(): void {
    for (const message of this.liveQueue.splice(0)) message.resolve();
    this.sendingLive?.abort();
  }
  private finishLive(live: LiveText): void {
    const index = this.liveQueue.findIndex(message => message.live === live);
    if (index >= 0) this.liveQueue.splice(index, 1)[0].resolve();
  }
  stream(text: string, signal: AbortSignal): LiveText | undefined {
    text = returnedFiles(text).text; // File declarations are consumed only after successful execution.
    if (!text.trim() || signal.aborted || this.signal.aborted) return;
    const live: LiveText = { parts: splitReply(text).map(text => ({ id: `wcode-${randomUUID()}`, text, sent: false })), done: Promise.resolve() };
    if (this.blocked || !this.store.state.contextToken || this.store.state.outbox.length) return live;
    let resolve!: () => void;
    const cancel = () => this.finishLive(live);
    live.done = new Promise<void>(done => { resolve = () => { signal.removeEventListener('abort', cancel); done(); }; });
    this.liveQueue.push({ live, signal, resolve });
    signal.addEventListener('abort', cancel, { once: true });
    this.flush();
    return live;
  }
  private enqueue(outbox: State['outbox']): void {
    this.store.state.outbox.push(...outbox);
    this.store.save();
    this.cancelLive();
    this.flush();
  }
  resume(): void {
    this.generation++;
    this.blocked = false;
    this.flush();
  }
  flush(): void {
    if (this.blocked || this.signal.aborted) { this.cancelLive(); return; }
    if (this.pending) return;
    this.pending = this.drain().catch(e => {
      this.blocked = true;
      if (!this.signal.aborted) this.onError(e, true);
    }).finally(() => {
      this.pending = undefined;
      if ((this.store.state.outbox.length || this.liveQueue.length) && this.store.state.contextToken) this.flush();
    });
  }
  async drain(): Promise<void> {
    const state = this.store.state;
    while ((state.outbox.length || this.liveQueue.length) && state.contextToken && !this.signal.aborted) {
      if (!state.outbox.length) {
        const message = this.liveQueue.shift()!;
        if (message.signal.aborted) { message.resolve(); continue; }
        const controller = new AbortController(); this.sendingLive = controller;
        try {
          for (const part of message.live.parts) {
            const signal = AbortSignal.any([this.signal, message.signal, controller.signal, AbortSignal.timeout(3_000)]);
            signal.throwIfAborted();
            await this.api.send(part.text, state.contextToken, part.id, signal);
            part.sent = true;
          }
        } catch (e) {
          if (!this.signal.aborted && (expired(e) || (!message.signal.aborted && !controller.signal.aborted))) this.onError(e);
        }
        finally { this.sendingLive = undefined; message.resolve(); }
        continue;
      }
      const message = state.outbox[0];
      for (let attempt = 0; ; attempt++) {
        const generation = this.generation;
        try {
          if (message.file) {
            if (!this.api.uploadFile || !this.api.sendFile) throw new Error('当前通道不支持文件回传');
            if (!message.item) {
              message.item = await this.api.uploadFile(message.file, this.signal);
              try { this.store.save(); } catch (e) { this.blocked = true; this.onError(e, true); return; }
            }
            await this.api.sendFile(message.item, state.contextToken, message.id, this.signal);
          } else await this.api.send(message.text, state.contextToken, message.id, this.signal);
          break;
        }
        catch (e) {
          // An owner message may arrive while the final attempt is still in flight.
          if (!expired(e) && !this.signal.aborted && attempt === 3 && generation !== this.generation) { attempt = -1; continue; }
          if (expired(e) || attempt === 3 || this.signal.aborted) { this.blocked = true; if (!this.signal.aborted) this.onError(e); return; }
          await sleep(this.retryMs * 2 ** attempt, undefined, { signal: this.signal });
        }
      }
      state.outbox.shift();
      this.store.save();
    }
  }
}
