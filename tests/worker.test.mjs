import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once as eventOnce } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { ExperimentStore } from '../src/server/storage/experiment-store.mjs';
import { RuntimeStore } from '../src/server/storage/runtime-store.mjs';
import { runWorker } from '../src/server/worker/runner.mjs';

const fixture = JSON.parse(readFileSync(new URL('../examples/plans/local-fixture.json', import.meta.url)));
const cli = fileURLToPath(new URL('../bin/decision-lab.mjs', import.meta.url));
const checkResult = new Ajv2020().compile(JSON.parse(readFileSync(new URL('../contracts/result.v1.schema.json', import.meta.url))));
const project = fixture.projectId;
const makePlan = () => structuredClone(fixture);
const envelope = { output: { selected: 'oos' }, invocations: [{ source: 'controlled-test-only', selected: 'oos' }] };
async function workspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'decision-worker-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const claim = (s, owner = 'worker-a', lease = 100) => { s.acquireWorker(project, owner, lease); return s.claimNext(project, owner, lease, ['controlled-fixture']); };
const first = (s, id) => s.get(id, project).executions[0];
function invoke(dir, args, expected = 0) {
  const child = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, NODE_OPTIONS: '', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' } });
  assert.equal(child.error, undefined);
  assert.equal(child.status, expected, child.stdout + child.stderr);
  if (args[0] === 'worker') { assert.equal(child.stdout, ''); return child; }
  const result = JSON.parse(child.stdout); assert.ok(checkResult(result), JSON.stringify(checkResult.errors)); return result;
}

test('v2 additive migration adopts machine plans, preserves legacy and supports read-only status', async () => workspace(async dir => {
  const path = join(dir, 'experiments.sqlite');
  let store = new ExperimentStore(path);
  const id = store.create(makePlan(), 'machine');
  const legacy = makePlan(); delete legacy.schemaVersion; delete legacy.budget;
  const old = store.create(legacy, 'legacy'); store.close();
  store = new RuntimeStore(path);
  try {
    assert.deepEqual(store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(x=>x.version), [1,2]);
    assert.equal(store.get(id, project).control.reserved_invocations, 0);
    assert.equal(store.get(old, project).control, null);
    await runWorker({store, projectId:project, once:true});
    assert.equal(first(store,id).state, 'succeeded'); assert.equal(first(store,old).state, 'queued');
    assert.equal(first(store,id).attempts[0].assessments[0].result.casePass, false, 'fixture selects first label; it does not read the oracle');
  } finally { store.close(); }
  const reader = new RuntimeStore(path,{readOnly:true});
  try { assert.equal(reader.get(id,project).control.reserved_invocations,1); assert.throws(()=>reader.db.prepare('DELETE FROM experiment_control').run()); }
  finally { reader.close(); }
}));

test('project ownership, invocation reservation and hard call limit are enforced transactionally', async () => workspace(dir => {
  let time = 1000; const path=join(dir,'run.sqlite'), a=new RuntimeStore(path,{clock:()=>time}), b=new RuntimeStore(path,{clock:()=>time});
  try {
    const plan=makePlan(); plan.suite.cases.push({...structuredClone(plan.suite.cases[0]),id:'second'});
    // Deliberately bypass application preflight to prove runtime limits independently.
    const id=a.create(plan,'key'), owned=claim(a);
    assert.throws(()=>b.acquireWorker(project,'worker-b',100),/WORKER_BUSY/);
    assert.equal(a.claimNext(project,'worker-a',100,['controlled-fixture']),null);
    assert.equal(a.authorizeInvocation(owned).allowed,true);
    assert.throws(()=>a.authorizeInvocation(owned),/ALREADY_AUTHORIZED/);
    a.recordResponse(owned,envelope); a.recordAssessment(owned.attemptId,project,plan.evaluation,undefined,owned);a.releaseExecution(owned);
    assert.equal(a.claimNext(project,'worker-a',100,['controlled-fixture']),null);
    const exp=b.get(id,project);
    assert.equal(exp.control.reserved_invocations,1);assert.equal(exp.control.stop_reason,'call_budget_exceeded');
    assert.deepEqual(exp.executions.map(x=>x.state),['succeeded','budget_exhausted']);
    assert.throws(()=>b.cancel(id,'other-project','operator'),/NOT_FOUND/);
    time+=101; b.acquireWorker(project,'worker-b',100);
    assert.throws(()=>a.pulse(project,'worker-a',100),/LEASE_LOST/);
    a.releaseWorker(project,'worker-a');assert.doesNotThrow(()=>b.assertWorker(project,'worker-b'));
  } finally { a.close();b.close(); }
}));

test('a claim interrupted before dispatch is safely requeued without consuming call budget', () => {
  let time=1000;const s=new RuntimeStore(':memory:',{clock:()=>time});
  try {
    const id=s.create(makePlan(),'key'), stale=claim(s);time+=101;s.acquireWorker(project,'worker-b',100);
    assert.deepEqual(s.recover(project,'worker-b',100),[]);
    assert.equal(first(s,id).state,'queued');assert.equal(s.get(id,project).control.reserved_invocations,0);
    assert.throws(()=>s.authorizeInvocation(stale),/LEASE_LOST|STALE/);
    const resumed=s.claimNext(project,'worker-b',100,['controlled-fixture']);assert.equal(s.authorizeInvocation(resumed).allowed,true);
    s.recordResponse(resumed,envelope);s.recordAssessment(resumed.attemptId,project,fixture.evaluation,undefined,resumed);
    assert.equal(first(s,id).attempts.length,2);assert.equal(s.get(id,project).control.reserved_invocations,1);
  }finally{s.close();}
});

test('response checkpoint recovery grades once without invoking an adapter and fences the old owner', async () => {
  let time=1000;const s=new RuntimeStore(':memory:',{clock:()=>time});
  try {
    const id=s.create(makePlan(),'key'), stale=claim(s);s.authorizeInvocation(stale);s.recordResponse(stale,envelope);time+=101;
    let calls=0;await runWorker({store:s,projectId:project,once:true,adapterFactory(){calls++;throw Error('must not be called');}});
    assert.equal(calls,0);assert.equal(first(s,id).state,'succeeded');
    assert.equal(first(s,id).attempts.length,1);assert.equal(first(s,id).attempts[0].assessments.length,1);
    assert.equal(s.get(id,project).control.reserved_invocations,1);
    assert.throws(()=>s.recordResponse(stale,envelope),/STALE|LEASE_LOST/);
    assert.throws(()=>s.recordAssessment(stale.attemptId,project,fixture.evaluation,undefined,stale),/STALE|LEASE_LOST/);
  }finally{s.close();}
});

test('dispatched interruption becomes outcome_unknown, retains reservation and never silently retries', async () => {
  let time=1000;const s=new RuntimeStore(':memory:',{clock:()=>time});
  try {
    const id=s.create(makePlan(),'key'), stale=claim(s);s.authorizeInvocation(stale);time+=101;
    let calls=0;await runWorker({store:s,projectId:project,once:true,adapterFactory(){calls++;throw Error('must not be called');}});
    assert.equal(calls,0);assert.equal(first(s,id).state,'outcome_unknown');
    assert.equal(s.get(id,project).control.reserved_invocations,1);assert.equal(first(s,id).attempts[0].observation,null);
    s.saveLateResponse(stale,envelope);assert.equal(first(s,id).state,'outcome_unknown');
    assert.ok(first(s,id).attempts[0].observation);assert.equal(first(s,id).attempts[0].assessments.length,0);
  }finally{s.close();}
});

test('cancellation is scoped and idempotent, preserves late evidence and prevents stale completion', () => {
  const s=new RuntimeStore(':memory:');
  try {
    const id=s.create(makePlan(),'key'), owned=claim(s,'worker-a',30000);s.authorizeInvocation(owned);
    assert.throws(()=>s.cancel(id,'other-project','operator'),/NOT_FOUND/);
    s.cancel(id,project,'operator');s.cancel(id,project,'operator');
    assert.equal(first(s,id).state,'cancelled');assert.equal(first(s,id).attempts[0].state,'outcome_unknown');
    assert.throws(()=>s.recordResponse(owned,envelope),/STALE/);s.saveLateResponse(owned,envelope);s.saveLateResponse(owned,envelope);
    assert.equal(first(s,id).state,'cancelled');assert.equal(first(s,id).attempts[0].invocations.length,1);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='ExperimentStopped'").get().n,1);
    assert.equal(s.get(id,project).control.reserved_invocations,1);
  }finally{s.close();}
});

test('wall runtime deadline aborts in-flight work and stops remaining executions without refund', async () => {
  const s=new RuntimeStore(':memory:');
  try {
    const plan=makePlan();plan.repeats=2;plan.budget={maxInvocations:2,maxRuntimeMs:25};const id=s.create(plan,'key');
    let calls=0;
    await runWorker({store:s,projectId:project,once:true,adapterFactory:()=>async(_,{signal})=>{
      calls++;await delay(5000,undefined,{signal});return envelope;
    }});
    assert.equal(calls,1);assert.equal(s.get(id,project).control.stop_reason,'runtime_exceeded');
    assert.deepEqual(s.get(id,project).executions.map(x=>x.state),['budget_exhausted','budget_exhausted']);
    assert.equal(s.get(id,project).control.reserved_invocations,1);
    assert.equal(first(s,id).attempts[0].state,'outcome_unknown');
  }finally{s.close();}
});

test('Worker observes cancellation from a separate connection and aborts the pending invocation', async () => workspace(async dir => {
  const path=join(dir,'run.sqlite'),s=new RuntimeStore(path),other=new RuntimeStore(path);
  try {
    const id=s.create(makePlan(),'key');let aborted=false;
    await runWorker({store:s,projectId:project,once:true,leaseMs:100,adapterFactory:()=>async(_,{signal})=>{
      other.cancel(id,project,'other-operator');
      try{await delay(5000,undefined,{signal});}catch{aborted=true;throw Error('sensitive diagnostic must not be saved');}
      return envelope;
    }});
    assert.equal(aborted,true);assert.equal(first(s,id).state,'cancelled');
    assert.ok(!JSON.stringify(s.get(id,project)).includes('sensitive diagnostic'));
  }finally{s.close();other.close();}
}));

test('live work requires explicit opt-in; missing credentials block before quota or network dispatch', async () => {
  const s=new RuntimeStore(':memory:');
  try {
    const plan=makePlan();plan.subject={id:'clef',revision:'1',adapter:'cloudflare-native',model:'clef',credentialRef:'env:CLOUDFLARE_API_TOKEN'};
    const id=s.create(plan,'key');let factories=0;
    await runWorker({store:s,projectId:project,once:true,adapterFactory(){factories++;throw Error('must not run');}});
    assert.equal(factories,0);assert.equal(first(s,id).state,'queued');
    await runWorker({store:s,projectId:project,once:true,allowLive:true,environment:{}});
    assert.equal(first(s,id).state,'blocked');assert.equal(first(s,id).attempts[0].error,'CREDENTIAL_UNAVAILABLE');
    assert.equal(s.get(id,project).control.reserved_invocations,0);
  }finally{s.close();}
});

test('wrong answers, invalid responses, upstream rejections and transport uncertainty have different persisted outcomes', async () => {
  const s=new RuntimeStore(':memory:');
  try{
    const ids=[];
    for(const name of ['wrong','invalid','rejected','network']){const p=makePlan();p.subject.id=name;ids.push(s.create(p,name));}
    await runWorker({store:s,projectId:project,once:true,adapterFactory:plan=>async()=>{
      if(plan.subject.id==='network')throw Error('secret diagnostic');
      return {output:plan.subject.id==='rejected'?{providerError:{code:'UPSTREAM_REJECTED',httpStatus:403}}:{selected:plan.subject.id==='invalid'?'not-a-label':'account_balance'},invocations:[{source:'test'}]};
    }});
    assert.deepEqual(ids.map(id=>first(s,id).state),['succeeded','invalid','failed','outcome_unknown']);
    assert.equal(first(s,ids[0]).attempts[0].assessments[0].result.casePass,false);
    assert.equal(first(s,ids[2]).attempts[0].error,'UPSTREAM_REJECTED');
    assert.ok(!JSON.stringify(s.get(ids[3],project)).includes('secret diagnostic'));
    assert.deepEqual(ids.map(id=>s.get(id,project).control.reserved_invocations),[1,1,1,1]);
  }finally{s.close();}
});

test('real CLI Worker completes a queued experiment after the creating process exits; cancellation is also a CLI use case', async () => workspace(async dir => {
  const file=fileURLToPath(new URL('../examples/plans/local-fixture.json',import.meta.url));
  const created=invoke(dir,['experiment','create','--file',file,'--project',project,'--idempotency-key','process-test']).data;
  const child=spawn(process.execPath,[cli,'worker','run','--project',project,'--once'],{cwd:dir,stdio:['ignore','pipe','pipe']});
  let output='',diagnostics='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>diagnostics+=b);
  const [code]=await eventOnce(child,'exit');assert.equal(code,0,diagnostics);assert.equal(output,'');
  const getArgs=['experiment','get','--id',created.experimentId,'--project',project];
  const result=invoke(dir,getArgs).data;assert.equal(result.executionCounts.states.succeeded,1);assert.equal(result.control.reservedInvocations,1);
  const next=invoke(dir,['experiment','create','--file',file,'--project',project,'--idempotency-key','cancel-test']).data;
  const cancelled=invoke(dir,['experiment','cancel','--id',next.experimentId,'--project',project,'--actor','test-operator']).data;
  assert.equal(cancelled.executionCounts.states.cancelled,1);assert.equal(cancelled.control.reservedInvocations,0);
  invoke(dir,['experiment','cancel','--id',next.experimentId,'--project',project,'--actor','test-operator']);
}));

for (const checkpoint of ['claimed','authorized','response-saved']) {
  test(`SIGKILL at ${checkpoint} checkpoint is recovered by a new CLI process without unsafe replay`,{timeout:15000},async()=>workspace(async dir=>{
    const file=fileURLToPath(new URL('../examples/plans/local-fixture.json',import.meta.url));
    const created=invoke(dir,['experiment','create','--file',file,'--project',project,'--idempotency-key','crash']).data;
    const runtimeUrl=new URL('../src/server/storage/runtime-store.mjs',import.meta.url).href;
    const driver=`import {RuntimeStore} from ${JSON.stringify(runtimeUrl)};
      const s=new RuntimeStore(${JSON.stringify(join(dir,'.local/decision-lab.sqlite'))});
      s.acquireWorker(${JSON.stringify(project)},'crash-owner',100);
      const c=s.claimNext(${JSON.stringify(project)},'crash-owner',100,['controlled-fixture']);
      if(${JSON.stringify(checkpoint)}!=='claimed')s.authorizeInvocation(c);
      if(${JSON.stringify(checkpoint)}==='response-saved')s.recordResponse(c,${JSON.stringify(envelope)});
      process.send({checkpoint:${JSON.stringify(checkpoint)}});setInterval(()=>{},1000);`;
    const child=spawn(process.execPath,['--input-type=module','-e',driver],{stdio:['ignore','ignore','pipe','ipc']});
    try{
      await eventOnce(child,'message');const exited=eventOnce(child,'exit');child.kill('SIGKILL');await exited;
      await delay(150);
      invoke(dir,['worker','run','--project',project,'--once']);
      const result=invoke(dir,['experiment','get','--id',created.experimentId,'--project',project]).data;
      const execution=result.executions[0];assert.equal(result.control.reservedInvocations,1);
      if(checkpoint==='authorized'){
        assert.equal(execution.state,'outcome_unknown');assert.equal(execution.attempts[0].hasSavedResponse,false);assert.equal(execution.attempts.length,1);
      }else{
        assert.equal(execution.state,'succeeded');assert.equal(execution.attempts.at(-1).invocations,1);assert.equal(execution.attempts.at(-1).assessments,1);
        assert.equal(execution.attempts.length,checkpoint==='claimed'?2:1);
      }
    }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  }));
}

test('a grading exception leaves response evidence available for explicit rescoring without another invocation',async()=>{
 const s=new RuntimeStore(':memory:');
 try{
  const id=s.create(makePlan(),'grading-failure'),original=s.recordAssessment.bind(s);
  s.recordAssessment=()=>{throw Error('do-not-persist-this-diagnostic');};
  await runWorker({store:s,projectId:project,once:true});
  const attempt=first(s,id).attempts[0];assert.equal(first(s,id).state,'failed');assert.ok(attempt.observation);
  assert.equal(attempt.error,'EVALUATION_FAILED');assert.equal(attempt.assessments.length,0);
  s.recordAssessment=original;s.recordAssessment(attempt.id,project,fixture.evaluation);
  assert.equal(first(s,id).state,'succeeded');assert.equal(s.get(id,project).control.reserved_invocations,1);
  assert.equal(first(s,id).attempts[0].invocations.length,1);
 }finally{s.close();}
});

test('continuous CLI Worker excludes another owner and releases ownership on graceful shutdown',{timeout:15000},async()=>workspace(async dir=>{
 const child=spawn(process.execPath,[cli,'worker','run','--project',project,'--lease-ms','1000'],{cwd:dir,stdio:['ignore','pipe','pipe']});
 let output='',diagnostics='';child.stdout.on('data',b=>output+=b);
 const started=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Worker startup timeout')),5000);
  child.stderr.on('data',b=>{diagnostics+=b;if(diagnostics.includes('WorkerStarted')){clearTimeout(timer);resolve();}});
  child.once('error',e=>{clearTimeout(timer);reject(e);});
  child.once('exit',code=>{clearTimeout(timer);reject(Error('Worker exited before startup: '+code));});
 });
 try{
  await started;
  const rejected=invoke(dir,['worker','run','--project',project,'--once'],1);assert.ok(rejected.stderr.includes('WORKER_BUSY'));
  const exited=eventOnce(child,'exit');child.kill('SIGTERM');const[code]=await exited;assert.equal(code,0,diagnostics);assert.equal(output,'');
  invoke(dir,['worker','run','--project',project,'--once']);
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}));

test('checkpointed responses remain gradeable after wall deadline while further model calls are stopped',async()=>{
 let time=1000;const s=new RuntimeStore(':memory:',{clock:()=>time});
 try{
  const p=makePlan();p.repeats=2;p.budget={maxInvocations:2,maxRuntimeMs:1};const id=s.create(p,'deadline-recovery');
  const c=claim(s);s.authorizeInvocation(c);s.recordResponse(c,envelope);time+=101;
  let calls=0;await runWorker({store:s,projectId:project,once:true,adapterFactory(){calls++;throw Error('must not be called');}});
  assert.equal(calls,0);assert.deepEqual(s.get(id,project).executions.map(e=>e.state),['succeeded','budget_exhausted']);
  assert.equal(s.get(id,project).control.reserved_invocations,1);assert.equal(s.get(id,project).control.stop_reason,'runtime_exceeded');
 }finally{s.close();}
});
