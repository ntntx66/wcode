import { record } from '../config.ts';
export type Inbound = { text: string; commandText: string; contextToken?: string };
const itemText = (item: Record<string, unknown>) => {
  const text = record(item.text_item).text ?? record(item.voice_item).text;
  return typeof text === 'string' ? text : '';
};
export function inbound(value: unknown, ownerId: string): Inbound | undefined {
  const msg = record(value);
  if (msg.message_type !== 1 || msg.from_user_id !== ownerId || msg.group_id) return;
  const items = Array.isArray(msg.item_list) ? msg.item_list.map(record) : [];
  const commandText = items.map(itemText).filter(Boolean).join('\n').trim();
  const quotes = items.map(item => {
    const ref = record(item.ref_msg), body = itemText(record(ref.message_item));
    return body || (typeof ref.title === 'string' ? ref.title : '');
  }).filter(Boolean);
  return {
    text: [...new Set(quotes)].map(t => `[引用]\n${t}\n[/引用]`).concat(commandText).join('\n').trim(),
    commandText, contextToken: typeof msg.context_token === 'string' ? msg.context_token : undefined,
  };
}
