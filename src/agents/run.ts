import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentEvent, AgentOptions, AgentSpec } from './types.ts';

export type RunOptions = AgentOptions & {
  prompt: string; cwd: string; signal: AbortSignal; onEvent: (event: AgentEvent) => void;
};
export async function run(spec: AgentSpec, o: RunOptions): Promise<string> {
  o.signal.throwIfAborted();
  const child = spawn(spec.command, spec.args(o), { cwd: o.cwd, detached: true, stdio: 'pipe' });
  let stderr = '', text = '', failure: Error | undefined, escalation: Promise<void> | undefined, finished = false;
  let lastText: string | undefined;
  const descendants = new Set<number>();
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    descendants.add(child.pid);
    // Codex creates separate process groups for its commands. Snapshot before SIGINT
    // and retain those IDs after reparenting, then discover any new children at SIGKILL.
    const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 1_000, maxBuffer: 4 * 1024 * 1024 });
    const rows = (ps.stdout ?? '').trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    let size: number;
    do {
      size = descendants.size;
      for (const [pid, ppid] of rows) if (pid > 0 && descendants.has(ppid)) descendants.add(pid);
    } while (size !== descendants.size);
    const groups = new Set([child.pid]);
    for (const [pid, , pgid] of rows) if (descendants.has(pid) && descendants.has(pgid)) groups.add(pgid);
    const targets = [...groups].map(id => -id);
    for (const [pid, , pgid] of rows) if (descendants.has(pid) && !groups.has(pgid)) targets.push(pid);
    if (ps.status !== 0) console.error('无法枚举子进程，将只停止 agent 进程组。');
    for (const target of targets) {
      try { process.kill(target, signal); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') failure = e as Error; }
    }
  };
  const stop = () => {
    if (escalation) return;
    kill('SIGINT');
    escalation = new Promise(resolve => setTimeout(() => { kill('SIGKILL'); resolve(); }, 5_000));
  };
  const closed = new Promise<number | null>(resolve => {
    child.on('error', e => { failure = e; });
    child.on('close', code => { finished = true; resolve(code); });
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data: string) => { stderr = (stderr + data).slice(-65_536); });
  child.stdin.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'EPIPE') failure = e; });
  o.signal.addEventListener('abort', stop, { once: true });
  if (o.signal.aborted) stop();
  child.stdin.end(spec.output === 'text' && o.system ? `${o.system}\n\n${o.prompt}` : o.prompt); // Text CLIs have no system prompt channel.
  try {
    if (spec.output === 'text') {
      child.stdout.setEncoding('utf8');
      for await (const chunk of child.stdout) {
        text += chunk;
        if (Buffer.byteLength(text) > 1_048_576) throw new Error('agent 文本输出超过 1 MiB');
      }
    } else {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        let obj: unknown;
        try { obj = JSON.parse(line); } catch { continue; }
        for (const event of spec.parseLine(obj)) {
          if (event.type === 'text') {
            if (!event.text.trim() || failure || o.signal.aborted) continue;
            text = event.text;
            if (lastText === text) continue; // Claude repeats the assistant answer in its result event.
            lastText = text;
          }
          if (event.type === 'tool') lastText = undefined;
          if (event.type === 'error') failure = new Error(event.message);
          o.onEvent(event);
        }
      }
    }
    const code = await closed;
    if (escalation) await escalation; // The leader may exit while grandchildren survive with closed pipes.
    o.signal.throwIfAborted();
    if (failure) throw failure;
    if (code !== 0) throw new Error(stderr.trim().split('\n').slice(-20).join('\n') || `${spec.name} 退出码 ${code}`);
    return text || '任务已结束，没有文本输出。';
  } catch (e) {
    if (!finished) stop();
    await closed; await escalation; throw e;
  } finally { o.signal.removeEventListener('abort', stop); }
}
