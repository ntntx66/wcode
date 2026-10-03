import { basename } from 'node:path';
import { directory } from './config.ts';
import type { Config } from './config.ts';
import { sessionKey, taskStatuses } from './store.ts';
import type { Store, TaskInput } from './store.ts';
import type { Replies } from './reply.ts';

const aliases: Record<string, string> = {
  '/help': 'help', '/帮助': 'help', '/status': 'status', '/状态': 'status', '/stop': 'stop', '/停止': 'stop',
  '/new': 'new', '/新建': 'new', '/agent': 'agent', '/cd': 'cd', '/model': 'model', '/more': 'more', '/更多': 'more',
  '/send': 'send', '/发送': 'send',
};
export const isCommand = (text: string): boolean => Object.hasOwn(aliases, text.trim().split(/\s+/, 1)[0]);
export type CommandHost = {
  store: Store; config: Config; replies: Replies;
  active?: { started: number; tool?: string }; queuedCount: number; stopTask(): void;
};
const summary = (inputs: TaskInput[]) => Array.from(inputs.map(input => input.text || `[${input.attachments.length} 个附件]`)
  .join(' / ').replace(/\s+/g, ' ')).slice(0, 100).join('');
const statusTime = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23', timeZoneName: 'longOffset',
});
export function command(text: string, bot: CommandHost): boolean {
  const [, word, tail = ''] = text.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [];
  const cmd = word && Object.hasOwn(aliases, word) ? aliases[word] : undefined;
  if (!cmd) return false;
  const arg = tail.trim(), { store, config, replies } = bot, s = store.state;
  const say = (text: string) => replies.send(text);
  if (bot.active && (cmd === 'new' || (['agent', 'cd', 'model'].includes(cmd) && arg))) {
    say('任务正在运行，请先 /stop，等停止后再切换。'); return true;
  }
  try {
    switch (cmd) {
      case 'help': say('/help /帮助：命令列表\n/status /状态：运行情况、排队和最近执行状态\n/stop /停止：停止并清空队列\n/new /新建：重开当前会话\n/agent [名称|序号]：查看或切换 agent\n/cd [名称|序号|绝对路径]：查看或切换项目，路径自动收录\n/cd rm 名称|序号：移除项目记录，不删除文件\n/model [名称|default]：查看或设置模型\n/more /更多：下一页\n/send /发送 路径：回传本机文件（≤100 MiB，路径无需引号）\n支持图片、文件和语音转写。发送失败的结果已保存，发任意新消息可触发补发。'); break;
      case 'status': say([
        `Agent：${s.agent} · 模型：${s.models[s.agent] ?? 'default'}`, `目录：${s.cwd}`,
        `会话：${config.agents[s.agent]?.type === 'text' ? '纯文本 CLI（无会话恢复）' : s.sessions[sessionKey(s)] ?? '新会话'}`,
        bot.active ? `状态：运行中 · 运行：${Math.floor((Date.now() - bot.active.started) / 1000)} 秒 · 工具：${bot.active.tool ?? '暂无'}` : '状态：空闲',
        `排队：${bot.queuedCount} · 待补发：${s.outbox.length} · 下一页：${s.pages.length} 段`,
        ...(s.task ? [
          `最近执行：${taskStatuses[s.task.status]} · ${s.task.agent} · ${s.task.cwd}`,
          ...(s.task.inputs.length ? [`请求：${summary(s.task.inputs)}`] : []),
          ...(s.task.started ? [`开始：${statusTime.format(s.task.started)}`] : []),
          ...(s.task.ended ? [`结束：${statusTime.format(s.task.ended)}`] : []),
          ...(s.task.queuedInputs?.length ? [`未执行 ${s.task.queuedInputs.length} 条：${summary(s.task.queuedInputs)}`] : []),
          ...(s.task.status === 'interrupted' ? ['未自动重跑，执行结果待核查。'] : []),
        ] : []),
      ].join('\n')); break;
      case 'stop': { const running = !!bot.active; bot.stopTask(); say(running ? '正在停止任务，队列已清空。' : '当前无运行任务，队列已清空。'); break; }
      case 'new':
        delete s.sessions[sessionKey(s)];
        s.pages = [];
        store.save();
        say('已新建当前 agent + 目录的会话。');
        break;
      case 'agent': {
        const names = Object.keys(config.agents);
        if (!arg) { say(names.map((n, i) => `${i + 1}. ${n}${n === s.agent ? '（当前）' : ''}`).join('\n')); break; }
        const name = /^\d+$/.test(arg) ? names[Number(arg) - 1] : arg;
        if (!name || !Object.hasOwn(config.agents, name)) throw new Error(`可选 agent：${names.join('、')}`);
        s.agent = name;
        s.pages = [];
        store.save();
        say(`已切换到 ${name}，${s.sessions[sessionKey(s)] ? '将续接已有会话' : '下轮新建会话'}。`);
        break;
      }
      case 'cd': {
        const entries = s.projects ?? config.projects;
        const list = (projects: typeof entries) => projects.map(project => `${entries.indexOf(project) + 1}. ${project.name}：${project.path}`).join('\n');
        if (!arg) { replies.send(`当前目录：${s.cwd}\n` + (list(entries) || '暂无项目，可直接 /cd /绝对路径'), false); break; }
        const remove = /^rm(?:\s|$)/.test(arg), target = remove ? arg.slice(2).trim() : arg;
        if (!target) throw new Error('用法：/cd rm 名称|序号');
        const numeric = /^\d+$/.test(target);
        const directPath = !remove && (target.startsWith('/') || target === '~' || target.startsWith('~/'));
        const matches = directPath ? [] : entries.filter(project => project.name === target);
        const selected = numeric ? entries[Number(target) - 1] : matches[0];
        if (numeric && !selected) throw new Error('项目序号不存在');
        if (!numeric && matches.length > 1) {
          replies.send(`项目别名「${target}」重复，请用 /cd ${remove ? 'rm ' : ''}序号选择：\n${list(matches)}`, false); break;
        }
        if (remove && !selected) throw new Error('项目不存在');
        const previous = { cwd: s.cwd, pages: s.pages, projects: s.projects };
        if (remove) s.projects = entries.filter(project => project !== selected);
        else {
          const path = directory(selected?.path ?? target);
          s.projects = entries.some(project => project.path === path) ? entries : [...entries, { name: basename(path) || path, path }];
          s.cwd = path;
          s.pages = [];
        }
        try { store.save(); }
        catch (e) { Object.assign(s, previous); throw e; }
        replies.send(remove ? `已移除项目：${selected!.name}，文件未删除。` :
          `目录：${s.cwd}\n${s.sessions[sessionKey(s)] ? '将续接此项目的会话。' : '下轮新建会话。'}`, false);
        break;
      }
      case 'model':
        if (!arg) { say(`模型：${s.models[s.agent] ?? 'default'}`); break; }
        if (arg === 'default') delete s.models[s.agent]; else s.models[s.agent] = arg;
        store.save();
        say(`模型：${s.models[s.agent] ?? 'default'}`);
        break;
      case 'more': replies.more(); break;
      case 'send':
        if (!arg) say('用法：/send 文件路径（相对当前项目，或绝对路径；无需引号）');
        else replies.file(arg, s.cwd);
        break;
    }
  } catch (e) { say(`❌ ${String(e instanceof Error ? e.message : e).slice(0, 500)}`); }
  return true;
}
