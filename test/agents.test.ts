import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { claude } from '../src/agents/claude.ts';
import { codex } from '../src/agents/codex.ts';
import { pi } from '../src/agents/pi.ts';
import { run } from '../src/agents/run.ts';
import type { AgentSpec } from '../src/agents/types.ts';
import { eventually, setup } from './helpers.ts';

for (const spec of [claude, codex, pi]) {
  test(`${spec.name}: real JSONL new/resumed sessions and tool activity`, () => {
    for (const turn of ['new', 'resume']) {
      const lines = readFileSync(new URL(`./fixtures/${spec.name}-${turn}.jsonl`, import.meta.url), 'utf8').trim().split('\n');
      const events = lines.flatMap(line => spec.parseLine(JSON.parse(line)));
      assert.ok(events.some(e => e.type === 'session'));
      if (turn === 'new') assert.ok(events.some(e => e.type === 'tool'));
      assert.deepEqual(events.filter(e => e.type === 'text').at(-1), { type: 'text', text: turn === 'new' ? 'WCODE_FIXTURE_OK' : 'WCODE_SESSION_7392' });
    }
    for (const malformed of [null, [], 42, 'noise', { type: 'assistant', message: null }, { type: 'message_end' }])
      assert.doesNotThrow(() => spec.parseLine(malformed));
    const args = spec.args({ sessionId: 'session-id', model: 'custom-model', extraArgs: ['--test-option'] });
    assert.ok(args.includes('session-id')); assert.ok(args.includes('custom-model')); assert.ok(args.includes('--test-option'));
    if (spec === codex) { assert.equal(args.at(-1), '-'); assert.ok(!args.includes('-C')); assert.ok(!args.includes('--sandbox')); }
  });
}
test('terminal errors survive partial output; tool failures and reconnects are not terminal', () => {
  assert.equal(claude.parseLine({ type: 'result', is_error: true, errors: ['bad'] })[0].type, 'error');
  assert.equal(codex.parseLine({ type: 'turn.failed', error: { message: 'bad' } })[0].type, 'error');
  assert.deepEqual(codex.parseLine({ type: 'error', message: 'reconnecting' }), []);
  assert.equal(pi.parseLine({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'bad' } })[0].type, 'error');
  assert.deepEqual(pi.parseLine({ type: 'tool_execution_end', isError: true }), []);
  assert.deepEqual(claude.parseLine({ type: 'assistant', parent_tool_use_id: 'child', message: { content: [{ type: 'text', text: 'intermediate subagent text' }] } }), []);
});
function fake(source: string): AgentSpec {
  return { name: 'fake', command: process.execPath, args: () => ['-e', source], parseLine: codex.parseLine };
}
test('runner preserves a large literal stdin prompt, cwd and final unterminated JSON line', async t => {
  const { home } = setup(t), prompt = '-n $(touch should-not-exist)\n' + '内容'.repeat(100_000), events: string[] = [];
  const spec = fake(`let prompt=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x=>prompt+=x); process.stdin.on('end',()=>{
    console.log('non-json noise'); console.log(JSON.stringify({type:'thread.started',thread_id:'session'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'intermediate'}}));
    process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({prompt,cwd:process.cwd()})}})); });`);
  const result = await run(spec, { prompt, cwd: home, signal: new AbortController().signal, onEvent: e => events.push(e.type) });
  assert.deepEqual(JSON.parse(result), { prompt, cwd: home }); assert.ok(events.includes('session'));
});
test('runner reports spawn failures, stderr tail, explicit stream errors and pre-abort', async t => {
  const { home } = setup(t), options = { prompt: 'x', cwd: home, signal: new AbortController().signal, onEvent: () => {} };
  await assert.rejects(run({ ...codex, command: '/missing-wcode-binary' }, options), /ENOENT/);
  await assert.rejects(run(fake(`for(let i=0;i<30;i++) console.error('failure-'+i); process.exitCode=7;`), options), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes('failure-9\n')); assert.ok(error.message.startsWith('failure-10\n')); return true;
  });
  await assert.rejects(run(fake(`console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'partial'}}));
    console.log(JSON.stringify({type:'turn.failed',error:{message:'terminal failure'}}));`), options), /terminal failure/);
  await assert.rejects(run(fake('process.exit(0)'), { ...options, signal: AbortSignal.abort(new Error('already stopped')) }), /already stopped/);
});
for (const detached of [false, true]) test(`SIGKILL reaches a stubborn grandchild after reparenting (own process group: ${detached})`, { timeout: 12_000 }, async t => {
  const { home } = setup(t), controller = new AbortController(); let pid = 0;
  const spec = fake(`const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"process.on('SIGINT',()=>{});console.log('ready');setInterval(()=>{},1000)"],{detached:${detached},stdio:['ignore','pipe','ignore']});
    child.stdout.once('data',()=>console.log(JSON.stringify({type:'thread.started',thread_id:String(child.pid)})));
    process.stdin.resume();setInterval(()=>{},1000);`);
  t.after(() => { if(pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  const done = run(spec, { prompt: 'x', cwd: home, signal: controller.signal, onEvent: e => {
    if (e.type === 'session') { pid = Number(e.id); controller.abort(new Error('stop-test')); }
  } });
  await assert.rejects(done, /stop-test/);
  await eventually(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  await sleep(10);
});
