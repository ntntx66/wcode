// Explicit opt-in integration test: uses the installed agents and their configured accounts.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir, isAgent, loadConfig, names } from '../src/config.ts';
import { claude } from '../src/agents/claude.ts';
import { codex } from '../src/agents/codex.ts';
import { pi } from '../src/agents/pi.ts';
import { run } from '../src/agents/run.ts';
import { withCancellation } from './cancellation.ts';

await withCancellation(async signal => {
  const config = loadConfig(dataDir());
  const selected = process.argv.slice(2).length ? process.argv.slice(2) : names;
  for (const name of selected) {
    signal.throwIfAborted();
    if (!isAgent(name)) throw new Error(`Unknown agent: ${name}`);
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), `wcode-smoke-${name}-`)));
    let sessionId: string | undefined = name === 'pi' ? randomUUID() : undefined;
    let tools = 0;
    const marker = `WCODE_${randomUUID().replaceAll('-', '')}`;
    const spec = { ...{ claude, codex, pi }[name], command: config.agents[name].command };
    try {
      for (const turn of ['new', 'resume']) {
        const started = Date.now();
        const result = await run(spec, {
          cwd, sessionId, extraArgs: config.agents[name].extraArgs, signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
          prompt: turn === 'new'
            ? `CLI protocol test: use only your shell tool to run printf wcode-fixture-ok. Do not read or modify files or use any other tools. Remember ${marker}. Reply exactly WCODE_FIXTURE_OK.`
            : 'Reply with only the marker I asked you to remember. Do not use tools.',
          onEvent: e => { if (e.type === 'session') sessionId = e.id; if (e.type === 'tool') tools++; },
        });
        assert.ok(sessionId); assert.equal(result.trim(), turn === 'new' ? 'WCODE_FIXTURE_OK' : marker);
        if (turn === 'new') assert.ok(tools > 0, 'expected a real tool event');
        console.log(`${name} ${turn}: OK (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }
});
