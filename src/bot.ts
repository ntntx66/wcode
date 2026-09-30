import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from './config.ts';
import { Store, sessionKey } from './store.ts';
import type { Auth } from './store.ts';
import { claude } from './agents/claude.ts';
import { codex } from './agents/codex.ts';
import { pi } from './agents/pi.ts';
import { run } from './agents/run.ts';
import { Ilink, expired } from './wechat/ilink.ts';
import type { Updates } from './wechat/ilink.ts';
import { inbound } from './wechat/inbound.ts';
import { Replies } from './reply.ts';
import { command } from './commands.ts';
import { isAgent } from './config.ts';
import { textAgent } from './agents/text.ts';
import type { Inbound } from './wechat/inbound.ts';
import { download } from './wechat/media.ts';
import type { Downloaded } from './wechat/media.ts';
import { fileInstructions } from './files.ts';

export type Channel = Pick<Ilink, 'updates' | 'send' | 'typing'> & Partial<Pick<Ilink, 'uploadFile' | 'sendFile'>>;
const preamble = '你的回复会发到微信，请简洁，先给结论，避免大段代码。';
export class Bot {
  store: Store; config: Config; auth: Auth; api: Channel; replies: Replies;
  controller = new AbortController(); queue: Inbound[] = []; failure?: unknown;
  download = download;
  active?: { started: number; tool?: string; controller: AbortController; done: Promise<void> };
  execute: typeof run; log: (text: string) => void;
  constructor(store: Store, config: Config, auth: Auth, api: Channel = new Ilink(auth), execute = run, log = console.error) {
    this.store = store; this.config = config; this.auth = auth; this.api = api; this.execute = execute; this.log = log;
    this.replies = new Replies(store, api, this.controller.signal, (e, fatal) => {
      if (!this.controller.signal.aborted) this.log(String(e));
      if (fatal || expired(e)) this.fail(e);
    });
  }
  fail(e: unknown): void { this.failure = e; this.controller.abort(); this.stopTask(); }
  stopTask(): void { this.queue = []; this.active?.controller.abort(new Error('任务已停止。')); }
  accept(batch: Updates): void {
    const s = this.store.state, messages = batch.msgs ?? [];
    if (!Array.isArray(messages)) throw new Error('iLink msgs 格式无效');
    if (messages.length && (!batch.get_updates_buf || typeof batch.get_updates_buf !== 'string')) throw new Error('拒绝处理没有新游标的消息批次');
    if (batch.get_updates_buf === s.cursor) return;
    if (typeof batch.get_updates_buf === 'string' && batch.get_updates_buf) {
      s.cursor = batch.get_updates_buf; this.store.save(); // Must succeed before any command or child process.
    }
    for (const msg of messages) {
      if (this.controller.signal.aborted) break;
      const input = inbound(msg, this.auth.ownerId);
      if (!input) { this.log('忽略非 owner、非用户或群消息'); continue; }
      if (input.contextToken) { s.contextToken = input.contextToken; this.store.save(); this.replies.resume(); }
      if (command(input.commandText, this)) continue;
      if (!input.text && !input.attachments.length) { this.replies.send('支持文本、语音转写、图片和文件；此消息没有可处理内容。'); continue; }
      if (this.active) { this.queue.push(input); this.replies.send(`已排队（${this.queue.length} 条）。`); }
      else this.startTurn([input]);
    }
  }
  startTurn(inputs: Inbound[]): void {
    this.replies.clearPages();
    const active = { started: Date.now(), controller: new AbortController(), done: Promise.resolve(), tool: undefined as string | undefined };
    this.active = active;
    active.done = this.turn(inputs, active).catch(e => this.fail(e)).finally(() => {
      this.active = undefined;
      if (!this.controller.signal.aborted && this.queue.length) {
        const next = this.queue.splice(0);
        try { this.startTurn(next); } catch (e) { this.fail(e); }
      }
    });
  }
  async turn(inputs: Inbound[], active: NonNullable<Bot['active']>): Promise<void> {
    const s = this.store.state, { agent, cwd } = s, key = sessionKey(s), previous = s.sessions[key];
    if (agent === 'pi' && !previous) { s.sessions[key] = randomUUID(); this.store.save(); }
    const signal = AbortSignal.any([active.controller.signal, this.controller.signal]);
    const timeout = setTimeout(() => active.controller.abort(new Error(`任务超过 ${this.config.turnTimeoutMinutes} 分钟，已停止。`)), this.config.turnTimeoutMinutes * 60_000);
    const typing = new AbortController();
    const heartbeat = this.api.typing(s.contextToken, AbortSignal.any([signal, typing.signal])).catch(e => {
      if (!this.controller.signal.aborted) this.log(`typing: ${e}`);
      if (expired(e)) this.fail(e);
    });
    let response: string, succeeded = false;
    try {
      const attachments = inputs.flatMap(input => input.attachments), files: Downloaded[] = [];
      if (attachments.length > 10) throw new Error('每轮最多接收 10 个附件，请分批发送');
      for (const attachment of attachments) {
        active.tool = '下载微信附件';
        files.push(await this.download(attachment, this.store.home, signal));
      }
      let prompt = inputs.map(input => input.text).filter(Boolean).join('\n\n') || '请分析收到的附件。';
      if (files.length) prompt += '\n\n[微信附件，已下载到本机]\n' + files.map(file => `${file.kind === 'image' ? '图片' : '文件'}：${JSON.stringify(file.path)}`).join('\n');
      const config = this.config.agents[agent];
      if (!config) throw new Error(`agent ${agent} 已移出配置，请用 /agent 切换`);
      const spec = isAgent(agent) ? { ...{ claude, codex, pi }[agent], command: config.command } : textAgent(agent, config);
      response = await this.execute(spec, {
        prompt, system: '[微信通道]\n' + (this.config.mobilePreamble ? preamble + '\n' : '') + fileInstructions, cwd,
        images: files.filter(file => file.kind === 'image').map(file => file.path),
        sessionId: s.sessions[key], model: s.models[agent], extraArgs: this.config.agents[agent].extraArgs, signal,
        onEvent: event => {
          if (event.type === 'session') { s.sessions[key] = event.id; this.store.save(); }
          if (event.type === 'tool') active.tool = `${event.name}${event.detail ? `：${event.detail}` : ''}`;
        },
      });
      succeeded = true;
    } catch (e) { response = `❌ ${agent}：${Array.from(String(e instanceof Error ? e.message : e)).slice(0, 500).join('')}`; }
    finally { clearTimeout(timeout); typing.abort(); await heartbeat; }
    this.replies.result(response, succeeded ? cwd : undefined);
  }
  async start(signal?: AbortSignal): Promise<void> {
    const stop = () => { this.controller.abort(); this.stopTask(); };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    let delay = 2_000, timeout = 35_000;
    try {
      while (!this.controller.signal.aborted) {
        let batch: Updates;
        try { batch = await this.api.updates(this.store.state.cursor, this.controller.signal, timeout); }
        catch (e) {
          if (this.controller.signal.aborted) break;
          if (expired(e)) throw e;
          this.log(`收消息失败，${delay / 1000} 秒后重试：${e}`);
          await sleep(delay, undefined, { signal: this.controller.signal }).catch(() => {});
          delay = Math.min(delay * 2, 30_000); continue;
        }
        if (this.controller.signal.aborted) break;
        delay = 2_000;
        if (typeof batch.longpolling_timeout_ms === 'number' && batch.longpolling_timeout_ms > 0)
          timeout = Math.min(Math.max(batch.longpolling_timeout_ms + 5_000, 10_000), 120_000);
        this.accept(batch);
      }
    } finally {
      stop(); await this.active?.done; await this.replies.pending;
      signal?.removeEventListener('abort', stop);
    }
    if (this.failure) throw this.failure;
  }
}
