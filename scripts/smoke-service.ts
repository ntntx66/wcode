// Loads only a temporary local process; never connects to WeChat or uses real credentials.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { service } from '../src/service.ts';
import { MAX_LOG_BYTES, rotateLog } from '../src/logs.ts';
import { withCancellation } from './cancellation.ts';

await withCancellation(async signal => {
  const home = mkdtempSync(join(tmpdir(), 'wcode-service-smoke-')), entry = join(home, 'fixture.mjs'), marker = join(home, 'started.json');
  writeFileSync(join(home, 'auth.json'), '{}');
  writeFileSync(entry, `import { writeFileSync } from 'node:fs';
  process.on('SIGUSR1',()=>process.stdout.write('wcode-log-after-rotation'));
  process.on('SIGTERM',()=>process.exit(0));
  process.stdout.write('x'.repeat(${MAX_LOG_BYTES + 1000}),()=>{
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({home:process.env.WCODE_HOME,args:process.argv.slice(2),pid:process.pid}));
  });setInterval(()=>{},1000);`);
  try {
    service('install', home, entry);
    let data: { home: string; args: string[]; pid: number } | undefined;
    for (let i = 0; i < 50; i++) {
      try { data = JSON.parse(readFileSync(marker, 'utf8')); break; } catch { await sleep(100, undefined, { signal }); }
    }
    assert.ok(data); assert.equal(data.home, home); assert.deepEqual(data.args, ['start']);
    const log = join(home, 'logs', 'stdout.log');
    assert.equal(rotateLog(log), true); assert.equal(statSync(log + '.1').size, MAX_LOG_BYTES);
    process.kill(data.pid, 'SIGUSR1');
    for (let i = 0; i < 50 && !statSync(log).size; i++) await sleep(100, undefined, { signal });
    assert.equal(readFileSync(log, 'utf8'), 'wcode-log-after-rotation');
    assert.equal(statSync(log).mode & 0o777, 0o600);
    console.log('launchd log rotation / continued writes: OK');
    service('uninstall', home, entry);
    for (let i = 0; i < 50; i++) {
      try { process.kill(data.pid, 0); } catch { console.log('launchd bootstrap / execution / bootout: OK'); data = undefined; break; }
      await sleep(100, undefined, { signal });
    }
    assert.equal(data, undefined, 'launchd process must stop');
  } finally { service('uninstall', home, entry); rmSync(home, { recursive: true, force: true }); }
});
