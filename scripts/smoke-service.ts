// Loads only a temporary local process; never connects to WeChat or uses real credentials.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { service } from '../src/service.ts';

const home = mkdtempSync(join(tmpdir(), 'wcode-service-smoke-')), entry = join(home, 'fixture.mjs'), marker = join(home, 'started.json');
writeFileSync(join(home, 'auth.json'), '{}');
writeFileSync(entry, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({home:process.env.WCODE_HOME,args:process.argv.slice(2),pid:process.pid}));
process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
try {
  service('install', home, entry);
  let data: { home: string; args: string[]; pid: number } | undefined;
  for (let i = 0; i < 50; i++) {
    try { data = JSON.parse(readFileSync(marker, 'utf8')); break; } catch { await sleep(100); }
  }
  assert.ok(data); assert.equal(data.home, home); assert.deepEqual(data.args, ['start']);
  service('uninstall', home, entry);
  for (let i = 0; i < 50; i++) {
    try { process.kill(data.pid, 0); } catch { console.log('launchd bootstrap / execution / bootout: OK'); data = undefined; break; }
    await sleep(100);
  }
  assert.equal(data, undefined, 'launchd process must stop');
} finally { service('uninstall', home, entry); rmSync(home, { recursive: true, force: true }); }
