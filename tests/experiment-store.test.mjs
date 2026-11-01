import test from 'node:test';
import assert from 'node:assert/strict';
import { ExperimentStore } from '../src/server/storage/experiment-store.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const makePlan = () => ({ projectId:'test-project',actorId:'test-actor',suite:{id:'suite',revision:'1',cases:[{id:'case',kind:'classification',input:{text:'outside domain',labels:['in','oos']},reference:{label:'oos'},source:{revision:'pinned-source'}}]},subject:{id:'fixture',revision:'1',adapter:'controlled-fixture'},protocol:{id:'subset',revision:'1',mode:'derived'},evaluation:{id:'label-match',revision:'1'},repeats:1 });

test('database create is atomic/idempotent, rejects conflicting retries and cross-project reads',()=>{
 const dir=mkdtempSync(join(tmpdir(),'decision-lab-')),store=new ExperimentStore(join(dir,'test.sqlite'));
 try{
  store.db.exec("CREATE TRIGGER reject_execution BEFORE INSERT ON executions BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
  assert.throws(()=>store.create(makePlan(),'key'),/injected/);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM experiments').get().n,0);
  store.db.exec('DROP TRIGGER reject_execution');
  const p=makePlan(),id=store.create(p,'key');assert.equal(store.create(p,'key'),id);
  p.suite.cases[0].reference.label='in';assert.throws(()=>store.create(p,'key'),/CONFLICT/);
  assert.equal(store.get(id,'test-project').snapshot.suite.cases[0].reference.label,'oos');
  assert.throws(()=>store.get(id,'other-project'),/NOT_FOUND/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('saved responses survive failed grading, DB reopen and rescoring without another invocation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'decision-lab-')),path=join(dir,'test.sqlite');let store=new ExperimentStore(path),calls=0;
 try{
  const id=store.create(makePlan(),'key'),execution=store.get(id,'test-project').executions[0];
  await assert.rejects(store.execute(execution.id,'test-project',async input=>{calls++;assert.equal(input.reference,undefined);return{output:{selected:'oos'},invocations:[{phase:'retrieve'},{selected:'oos'}]};},{evaluator(){throw Error('grading fault');}}),/grading fault/);
  const before=store.get(id,'test-project');assert.ok(before.executions[0].attempts[0].observation);assert.equal(before.executions[0].attempts[0].invocations.length,2);
  store.close();store=new ExperimentStore(path);
  const attempt=store.get(id,'test-project').executions[0].attempts[0];
  assert.equal(store.recordAssessment(attempt.id,'test-project',{id:'label-match',revision:'1'}).casePass,true);
  store.recordAssessment(attempt.id,'test-project',{id:'label-match',revision:'2'});
  assert.equal(calls,1);const after=store.get(id,'test-project');assert.equal(after.executions.length,1);assert.equal(after.executions[0].attempts[0].assessments.length,2);
  assert.equal(after.executions[0].attempts[0].observation.raw_hash,attempt.observation.raw_hash);
  assert.equal(after.executions[0].state,'succeeded');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('duplicate claims, stale generation and corrupted evidence are rejected',()=>{
 const store=new ExperimentStore(':memory:');
 try{
  const id=store.create(makePlan(),'key'),execution=store.get(id,'test-project').executions[0],claim=store.claim(execution.id,'test-project');
  assert.throws(()=>store.claim(execution.id,'test-project'),/NOT_QUEUED/);
  store.db.prepare('UPDATE executions SET generation=generation+1 WHERE id=?').run(execution.id);
  assert.throws(()=>store.recordResponse(claim,{output:{selected:'oos'}}),/STALE/);
  store.db.prepare('UPDATE executions SET generation=? WHERE id=?').run(claim.generation,execution.id);
  store.recordResponse(claim,{output:{selected:'oos'}});
  store.db.prepare("UPDATE observations SET raw='{}'").run();
  assert.throws(()=>store.get(id,'test-project'),/INTEGRITY/);
 }finally{store.close();}
});
