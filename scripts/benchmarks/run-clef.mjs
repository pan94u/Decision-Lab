import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ExperimentStore } from '../../src/server/storage/experiment-store.mjs';
import { createClefAdapter, clefRequest } from '../../src/server/adapters/clef.mjs';
import { fingerprint } from '../../src/domain/benchmark.mjs';

const root = new URL('../../',import.meta.url), env = new URL('.env',root);
if (existsSync(env)) loadEnvFile(env);
const model='clef', directory=new URL('artifacts/clef-benchmark/',root);
await mkdir(directory,{recursive:true});
const packetsPath = new URL('artifacts/benchmark-verification/packets.json',root);
if(!existsSync(packetsPath))throw Error('Run npm run benchmark:verify once to prepare the pinned source cases.');
const packets=JSON.parse(await readFile(packetsPath,'utf8')).filter(packet=>['mmlu','clinc'].includes(packet.idempotencyKey));
const timestamp=new Date().toISOString(), stamp=timestamp.replace(/[:.]/g,'-');
const database=new URL(`experiments-${stamp}.sqlite`,directory), store=new ExperimentStore(fileURLToPath(database));
const adapter=createClefAdapter({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,apiToken:process.env.CLOUDFLARE_API_TOKEN,model});
const reports=[];let sent=0,stop=false;
const implementationHash=createHash('sha256').update(await readFile(new URL('src/server/adapters/clef.mjs',root))).digest('hex');
try {
 for(const packet of packets){
  const name=packet.idempotencyKey, plan=structuredClone(packet.plan);
  plan.subject={id:'cloudflare-clef',revision:'native-choice/1',adapter:'cloudflare-native',model,credentialRef:'env:CLOUDFLARE_API_TOKEN',implementationSha256:implementationHash};
  plan.actorId='local-clef-benchmark';plan.projectId='real-model-benchmark';
  plan.protocol={id:`clef-native-${name}-subset`,revision:'1',mode:'derived',sourceManifestSha256:packet.plan.protocol.sourceManifestSha256,
   sourceRevisions:[...new Set(plan.suite.cases.map(c=>c.source.revision))],caseSelection:plan.suite.cases.map(c=>c.source.itemId),
   responseSource:'live Cloudflare CLEF native decision API',candidateOrder:'preserved from pinned case inputs',repeats:1,
   adaptation:name==='mmlu'?'Keep original five-shot prompt and repeat final candidates in a native choice schema; not original token-logprob protocol.':'Use full 150 supported intent names plus oos; humanize names, no label subset or oracle shortlist.',
   limits:{maxRequests:10,timeoutMs:60000,automaticRetries:0},
  };
  const id=store.create(plan,`${stamp}:${name}`);
  for(const execution of store.get(id,plan.projectId).executions){
   if(stop)break;
   if(sent>=10)throw Error('LIVE_REQUEST_BUDGET_EXCEEDED');
   try{
    sent++;
    const result=await store.execute(execution.id,plan.projectId,adapter);
    const attempt=store.get(id,plan.projectId).executions.find(e=>e.id===execution.id).attempts[0];
    const call=attempt.invocations[0].raw, providerError=attempt.observation.raw.providerError;
    console.log(JSON.stringify({benchmark:name,case:execution.case_id,status:result.status,correct:result.casePass,selected:attempt.observation.raw.selected||null,httpStatus:call.httpStatus,elapsedMs:call.elapsedMs,...(providerError?{error:providerError.code}:{})}));
    if([401,403,429].includes(call.httpStatus))stop=true;
   }catch(e){console.log(JSON.stringify({benchmark:name,case:execution.case_id,error:e.code||'EXECUTION_ERROR'}));if(e.code==='MISSING_CREDENTIALS')stop=true;}
  }
  const report=store.report(id,plan.projectId), valid=[];const latencies=[],usage=[];
  let correct=0;
  const details=report.experiment.executions.map(execution=>{
   const c=plan.suite.cases.find(c=>c.id===execution.case_id),attempt=execution.attempts[0],assessment=attempt?.assessments.at(-1)?.result;
   const item=assessment?.units[0], raw=attempt?.observation?.raw, invocation=attempt?.invocations[0]?.raw;
   if(item?.valid){valid.push(item);if(item.correct)correct++;}
   if(invocation){latencies.push(invocation.elapsedMs);if(invocation.usage)usage.push(invocation.usage);}
   return {caseId:c.id,source:c.source,expected:c.reference.label,predicted:raw?.selected||null,correct:!!assessment?.casePass,state:execution.state,probabilityOfExpected:item?.probabilities?.[c.reference.label]??null,selectedProbability:item?.probabilities?.[raw?.selected]??null,apiConfidence:raw?.confidence??null,httpStatus:invocation?.httpStatus??null,error:raw?.providerError||attempt?.error||null};
  });
  const probabilityItems=valid.filter(x=>x.probabilities),average=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
  const metrics={plannedCases:plan.suite.cases.length,completedRequests:latencies.length,validAnswers:valid.length,correct,
   endToEndAccuracy:correct/plan.suite.cases.length,validAnswerAccuracy:valid.length?correct/valid.length:null,
   macroF1ObservedLabels:report.summary.macroF1ObservedLabels,
   normalizedBrier:average(probabilityItems.map(x=>Object.entries(x.probabilities).reduce((sum,[label,p])=>sum+(p-Number(label===x.expected))**2,0)/2)),
   nll:average(probabilityItems.map(x=>-Math.log(Math.max(1e-15,x.probabilities[x.expected])))),averageLatencyMs:average(latencies),
   providerUsage:usage,
  };
  if(name==='clinc'){
   const oos=details.filter(d=>d.expected==='oos');metrics.oosRecall=oos.length?oos.filter(d=>d.predicted==='oos').length/oos.length:null;
   metrics.inScopeAccuracy=details.filter(d=>d.expected!=='oos').filter(d=>d.correct).length/details.filter(d=>d.expected!=='oos').length;
  }
  reports.push({benchmark:name,experimentId:id,planHash:report.experiment.planHash,protocol:plan.protocol,metrics,details,evidence:report});
  await writeFile(new URL('report.json',directory),JSON.stringify({purpose:'Live CLEF benchmark subset; derived protocols, not official full benchmark scores',startedAt:timestamp,updatedAt:new Date().toISOString(),model,requestsSent:sent,stoppedEarly:stop,database:fileURLToPath(database),skipped:[{benchmark:'IFEval',reason:'CLEF cannot natively generate the free-form responses required by the benchmark.'}],reports},null,2));
 }
}finally{store.close();}
console.log(JSON.stringify({report:fileURLToPath(new URL('report.json',directory)),requestsSent:sent,benchmarks:reports.map(r=>({benchmark:r.benchmark,...r.metrics,providerUsage:undefined}))}));
