import test from 'node:test';import assert from 'node:assert/strict';
import {clefRequest,createClefAdapter} from '../src/server/adapters/clef.mjs';
const request={caseId:'a',kind:'classification',input:{text:'unknown request',labels:['balance','oos']}};
test('native schema supports complete label space and rejects text generation',()=>{
 const labels=[...Array.from({length:150},(_,i)=>'intent_'+i),'oos'];
 const payload=clefRequest({...request,input:{...request.input,labels}});
 assert.equal(Object.keys(payload.questions.decision.criteria).length,151);assert.equal(payload.model,'clef');assert.equal(payload.messages,undefined);
 assert.throws(()=>clefRequest({...request,kind:'instructions'}),/not text generation/);
});
test('live adapter retains original response and timing, excludes authorization',async()=>{
 const adapter=createClefAdapter({accountId:'0'.repeat(32),apiToken:'test-key',transport:async(url,init)=>{
  assert.equal(init.redirect,'manual');assert.equal(init.headers.authorization,'Bearer test-key');
  const payload=JSON.parse(init.body);assert.equal(payload.state.utterance,request.input.text);assert.equal(payload.reference,undefined);
  return Response.json({success:true,result:{model:'clef',answers:{decision:{choice:'oos',probabilities:{balance:0.1,oos:0.9},confidence:0.8}},usage:{input_tokens:10}}});
 }});
 const result=await adapter(request);assert.equal(result.output.selected,'oos');assert.equal(result.invocations[0].httpStatus,200);assert.ok(result.invocations[0].rawBody.includes('answers'));assert.ok(!JSON.stringify(result).includes('test-key'));
});
test('redirects and auth failures are retained as error evidence, never followed',async()=>{
 for(const status of [302,403]){
  let calls=0;const adapter=createClefAdapter({accountId:'0'.repeat(32),apiToken:'test-key',transport:async()=>{calls++;return new Response('test-key',{status});}});
  const result=await adapter(request);assert.equal(calls,1);assert.equal(result.output.providerError.httpStatus,status);assert.ok(!JSON.stringify(result).includes('test-key'));assert.equal(result.invocations[0].redacted,true);
 }
});
