import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { initialState, Store } from '../src/store.ts';
import { loadConfig } from '../src/config.ts';
import type { Auth } from '../src/store.ts';
import type { Channel } from '../src/bot.ts';
import type { Replies } from '../src/reply.ts';

// Replies prepares a result; the caller commits it together with its own state transition.
export function deliverResult(replies: Replies, ...args: Parameters<Replies['prepareResult']>): void {
  const result = replies.prepareResult(...args);
  replies.store.state.pages = result.pages;
  replies.store.state.outbox.push(...result.outbox);
  replies.store.save();
  if (!args[2]) replies.cancelLive();
  replies.flush();
}

export const auth: Auth = { token: 'test-token', ownerId: 'owner', botId: 'bot', baseUrl: 'https://ilinkai.weixin.qq.com' };
export function setup(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wcode-test-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, store: new Store(home, initialState('claude', home)), config: loadConfig(home) };
}
export const message = (text: string, token = 'context') => ({
  message_type: 1, from_user_id: 'owner', context_token: token, item_list: [{ type: 1, text_item: { text } }],
});
export const untilAbort = (signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
});
export function channel(sent: string[] = []): Channel {
  return { send: async text => { sent.push(text); }, typing: (_token, signal) => untilAbort(signal),
    updates: async (_cursor, signal) => { await untilAbort(signal); return {}; } };
}
export async function eventually(predicate: () => boolean, timeout = 3_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition timed out');
    await sleep(5);
  }
}
