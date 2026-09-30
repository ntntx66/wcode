// Explicit integration test: consumes the installed agents' configured model accounts.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { dataDir, isAgent, loadConfig, names } from '../src/config.ts';
import { claude } from '../src/agents/claude.ts';
import { codex } from '../src/agents/codex.ts';
import { pi } from '../src/agents/pi.ts';
import { run } from '../src/agents/run.ts';

const config = loadConfig(dataDir());
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : names) {
  if (!isAgent(name)) throw new Error(`Unknown agent: ${name}`);
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), `wcode-media-${name}-`)));
  let sessionId: string | undefined = name === 'pi' ? randomUUID() : undefined;
  try {
    for (const scene of ['a', 'b']) {
      const path = fileURLToPath(new URL(`../test/fixtures/scene-${scene}.png`, import.meta.url)), start = Date.now();
      const result = await run({ ...{ claude, codex, pi }[name], command: config.agents[name].command }, {
        cwd, sessionId, model: process.env.WCODE_SMOKE_MODEL, extraArgs: config.agents[name].extraArgs, images: [path], signal: AbortSignal.timeout(240_000),
        prompt: `Inspect the image at ${JSON.stringify(path)}. Describe the left and right colored shapes. Reply exactly in this format using lowercase English: LEFT=<color> <shape>; RIGHT=<color> <shape>. Do not modify files.`,
        onEvent: event => { if (event.type === 'session') sessionId = event.id; },
      });
      assert.ok(sessionId);
      const expected = scene === 'a' ? /LEFT=red square;\s*RIGHT=blue circle/i : /LEFT=green triangle;\s*RIGHT=yellow rectangle/i;
      assert.match(result, expected, `${name}: ${result}`);
      console.log(`${name} ${scene === 'a' ? 'new' : 'resume'} image: OK (${((Date.now() - start) / 1000).toFixed(1)}s), ${result.trim()}`);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
