import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson } from '../src/json.ts';
import { eventually, setup } from './helpers.ts';

for (const [script, signal] of [['smoke-agents.ts', 'SIGINT'], ['smoke-media.ts', 'SIGTERM']] as const) {
  test(`${script} forwards ${signal}, awaits a stubborn child and removes its workspace`, { timeout: 15_000 }, async t => {
    const { home } = setup(t), marker = join(home, 'child.json'), agent = join(home, 'fake-agent');
    writeFileSync(agent, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
process.on('SIGINT', () => {});
process.stdin.resume();
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,cwd:process.cwd()}));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    writeJson(join(home, 'config.json'), { agents: { claude: { command: agent } } });
    const child = spawn(process.execPath, [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), 'claude'], {
      env: { ...process.env, WCODE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { stderr += text; });
    const exited = once(child, 'exit');
    let data: { pid: number; cwd: string } | undefined;
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      if (data) {
        try { process.kill(-data.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
        rmSync(data.cwd, { recursive: true, force: true });
      }
    });
    await eventually(() => existsSync(marker), 3_000);
    data = JSON.parse(readFileSync(marker, 'utf8'));
    assert.ok(data);
    child.kill(signal);
    await eventually(() => child.exitCode !== null || child.signalCode !== null, 9_000);
    assert.equal(child.signalCode, null, stderr);
    assert.notEqual(child.exitCode, 0, stderr);
    assert.match(stderr, /Smoke test interrupted/);
    await eventually(() => { try { process.kill(data!.pid, 0); return false; } catch { return true; } });
    assert.equal(existsSync(data.cwd), false);
  });
}
