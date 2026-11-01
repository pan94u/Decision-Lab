import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, validatePlan, adapterInput, assess, aggregate } from '../src/domain/benchmark.mjs';

const makePlan = () => ({ projectId:'test-project',actorId:'test-actor',suite:{id:'suite',revision:'1',cases:[{id:'case',kind:'classification',input:{text:'outside domain',labels:['in','oos']},reference:{label:'oos'},source:{revision:'pinned-source'}}]},subject:{id:'fixture',revision:'1',adapter:'controlled-fixture'},protocol:{id:'subset',revision:'1',mode:'derived'},evaluation:{id:'label-match',revision:'1'},repeats:1 });

test('canonical hashes preserve candidate order and freeze protocol identity',()=>{
 const p=makePlan();assert.equal(fingerprint(p),fingerprint(JSON.parse(JSON.stringify(p))));
 const permuted=structuredClone(p);permuted.suite.cases[0].input.labels.reverse();assert.notEqual(fingerprint(p),fingerprint(permuted));
 const changed=structuredClone(p);changed.protocol.revision='2';assert.notEqual(fingerprint(p),fingerprint(changed));
 assert.throws(()=>fingerprint({token:'do-not-persist'}),/Secret/);
 assert.throws(()=>fingerprint({value:NaN}),/finite/);
});

test('151-label CLINC-style space and legal OOS work without an API-specific cap',()=>{
 const p=makePlan();p.suite.cases[0].input.labels=[...Array.from({length:150},(_,i)=>'intent-'+i),'oos'];validatePlan(p);
 const c=p.suite.cases[0];assert.equal(assess(c,{selected:'oos'},p.evaluation).casePass,true);
 assert.equal(assess(c,{selected:'UNKNOWN'},p.evaluation).status,'invalid');
 const input=adapterInput(c,p.protocol,p.subject);assert.equal(input.reference,undefined);assert.equal(input.input.reference,undefined);
});

test('instruction and prompt results differ, strict and loose are explicit',()=>{
 const c={id:'multi',kind:'instructions',input:{criteria:[{id:'startend:quotation',args:{}},{id:'keywords:existence',args:{keywords:['python','java']}}]}};
 const strict=assess(c,{text:'"python"'},{id:'ifeval',revision:'1',variant:'strict'});
 assert.deepEqual(strict.units.map(x=>x.correct),[true,false]);assert.equal(strict.casePass,false);assert.equal(aggregate([strict]).unitAccuracy,0.5);
 const raw={text:'Preamble\n"python java"\nPostscript'};
 assert.equal(assess(c,raw,{id:'ifeval',revision:'1',variant:'strict'}).casePass,false);
 assert.equal(assess(c,raw,{id:'ifeval',revision:'1',variant:'loose'}).casePass,true);
});

