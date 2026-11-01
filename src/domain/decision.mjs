const safeKey=k=>/^[a-zA-Z0-9_.-]{1,100}$/.test(k)&&!['__proto__','constructor','prototype'].includes(k);
const finite=n=>typeof n==='number'&&Number.isFinite(n);
export function validateTask(t){
 if(!t||typeof t.title!=='string'||!t.title.trim()||t.title.length>120)throw Error('任务需要 1–120 字的 title');
 if(t.state===undefined||t.state===null||JSON.stringify(t.state).length>80000)throw Error('state 必填，且不超过 80000 字符');
 if(!t.questions||Array.isArray(t.questions)||typeof t.questions!=='object')throw Error('questions 必须是问题 ID 到类型化问题的映射');
 const entries=Object.entries(t.questions);if(entries.length<1||entries.length>64)throw Error('每个场景需 1–64 个问题');
 if(!t.expected||typeof t.expected!=='object'||Array.isArray(t.expected))throw Error('expected 必须提供每个问题的参考标签');
 for(const [id,q] of entries){
  if(!safeKey(id)||!q||!['noul','choice','score'].includes(q.type))throw Error('问题 ID 或 type 无效：'+id);
  if(typeof q.instructions!=='string'||!q.instructions.trim()||q.instructions.length>4000)throw Error(id+' 需要 instructions');
  const y=t.expected[id];
  if(q.type==='noul'){if(typeof y!=='boolean')throw Error(id+' 的 expected 必须是布尔值');}
  if(q.type==='choice'){if(!q.criteria||Array.isArray(q.criteria)||typeof q.criteria!=='object'||Object.keys(q.criteria).length<2||Object.keys(q.criteria).length>50||Object.entries(q.criteria).some(([k,v])=>!safeKey(k)||typeof v!=='string'||!v.trim()))throw Error(id+' 需要 2–50 个命名 criteria');if(typeof y!=='string'||!Object.hasOwn(q.criteria,y))throw Error(id+' 的参考标签不在 criteria 中');}
  if(q.type==='score'){if(!Array.isArray(q.criteria)||q.criteria.length<2||q.criteria.length>10||q.criteria.some(v=>typeof v!=='string'||!v.trim()))throw Error(id+' 的 criteria 需要 2–10 个有序等级描述');if(!Number.isInteger(y)||y<0||y>=q.criteria.length)throw Error(id+' 的参考标签应为从 0 开始的等级整数');}
 }
 if(t.workflow){if(!t.questions[t.workflow.routeQuestion]||t.questions[t.workflow.routeQuestion].type!=='choice'||(t.workflow.escalateQuestion&&t.questions[t.workflow.escalateQuestion]?.type!=='noul'))throw Error('workflow 需引用有效的 choice 路由和可选 noul 升级问题');}
 return t;
}
export function modelInput(t,model='clef'){
 // Strict allowlist: references, labels, evaluator metadata and workflow rules never enter the request.
 return {model,state:t.state,questions:Object.fromEntries(Object.entries(t.questions).map(([id,q])=>[id,{type:q.type,instructions:q.instructions,...(q.criteria!==undefined?{criteria:q.criteria}:{})}]))};
}
export function normalizeAnswers(t,response){
 const answers=response?.answers;if(!answers||typeof answers!=='object'||Array.isArray(answers))throw Error('响应缺少 answers 对象');
 return Object.entries(t.questions).map(([id,q])=>{const a=answers[id];if(a===undefined||a===null)throw Error('缺少问题答案：'+id);let probabilities,prediction,score=null,confidence=null;
  if(q.type==='noul'){const p=typeof a==='number'?a:a.noul;if(!finite(p)||p<0||p>1)throw Error(id+' 的 noul 必须为 0–1 概率');probabilities={false:1-p,true:p};prediction=p>=0.5;confidence=Math.abs(2*p-1);}
  else{const keys=q.type==='choice'?Object.keys(q.criteria):q.criteria.map((_,i)=>String(i));const ps=a.probabilities;if(!ps||typeof ps!=='object'||Object.keys(ps).length!==keys.length||keys.some(k=>!finite(ps[k])||ps[k]<0||ps[k]>1))throw Error(id+' 概率分布缺失或无效');const sum=keys.reduce((s,k)=>s+ps[k],0);if(Math.abs(sum-1)>0.002)throw Error(id+' 概率之和不是 1');probabilities=Object.fromEntries(keys.map(k=>[k,ps[k]/sum]));const top=keys.reduce((b,k)=>probabilities[k]>probabilities[b]?k:b,keys[0]);
   if(q.type==='choice'){if(!keys.includes(a.choice)||probabilities[a.choice]<probabilities[top]-0.002)throw Error(id+' choice 与概率分布不一致');prediction=a.choice;}
   else{score=keys.reduce((s,k)=>s+Number(k)*probabilities[k],0);if(!finite(a.score)||Math.abs(a.score-score)>0.02)throw Error(id+' score 与概率加权均值不一致');prediction=Number(top);}
   if(a.confidence!==undefined){if(!finite(a.confidence)||a.confidence<0||a.confidence>1)throw Error(id+' confidence 无效');confidence=a.confidence;}
  }
  return {id,type:q.type,prediction,probabilities,score,confidence,topProbability:probabilities[String(prediction)]};
 });
}
export function grade(t,response){const items=normalizeAnswers(t,response).map(a=>{const expected=t.expected[a.id],correct=a.prediction===expected;const brier=a.type==='noul'?(a.probabilities.true-Number(expected))**2:Object.entries(a.probabilities).reduce((s,[k,p])=>s+(p-Number(k===String(expected)))**2,0)/2;return {...a,expected,correct,brier,nll:-Math.log(Math.max(1e-15,a.probabilities[String(expected)])),mae:a.type==='score'?Math.abs(a.score-expected):null};});const workflow=t.workflow?{route:items.find(x=>x.id===t.workflow.routeQuestion).prediction,expectedRoute:t.expected[t.workflow.routeQuestion],escalate:t.workflow.escalateQuestion?items.find(x=>x.id===t.workflow.escalateQuestion).prediction:false,expectedEscalate:t.workflow.escalateQuestion?t.expected[t.workflow.escalateQuestion]:false}:null;return {items,score:items.filter(x=>x.correct).length/items.length*100,caseExact:items.every(x=>x.correct),brier:items.reduce((s,x)=>s+x.brier,0)/items.length,workflow};}
export function summarize(results,threshold=0.8){const all=results.flatMap(x=>x.grade?.items||[]),total=results.reduce((s,x)=>s+Object.keys(x.task.questions).length,0),accepted=all.filter(x=>x.topProbability>=threshold),scores=all.filter(x=>x.type==='score');const avg=a=>a.length?a.reduce((a,b)=>a+b,0)/a.length:null;let ece=0;const bins=Array.from({length:10},(_,i)=>{const items=all.filter(x=>Math.min(9,Math.floor(x.topProbability*10))===i);const accuracy=avg(items.map(x=>Number(x.correct))),probability=avg(items.map(x=>x.topProbability));if(items.length)ece+=items.length/Math.max(1,all.length)*Math.abs(accuracy-probability);return {low:i/10,high:(i+1)/10,n:items.length,accuracy,probability};});return {total,valid:all.length,accuracy:total?all.filter(x=>x.correct).length/total:null,caseExact:results.length?results.filter(x=>x.grade?.caseExact).length/results.length:null,brier:avg(all.map(x=>x.brier)),nll:avg(all.map(x=>x.nll)),mae:avg(scores.map(x=>x.mae)),ece:all.length?ece:null,bins,coverage:total?accepted.length/total:null,selectiveError:accepted.length?accepted.filter(x=>!x.correct).length/accepted.length:null,accepted:accepted.length};}
export function demo(t,mode='uniform'){return {model:mode==='oracle'?'reference-oracle':'uniform-baseline',answers:Object.fromEntries(Object.entries(t.questions).map(([id,q])=>{const y=t.expected[id];if(q.type==='noul')return [id,{type:'noul',noul:mode==='oracle'?Number(y):0.5}];const keys=q.type==='choice'?Object.keys(q.criteria):q.criteria.map((_,i)=>String(i));const probabilities=Object.fromEntries(keys.map(k=>[k,mode==='oracle'?Number(k===String(y)):1/keys.length]));return [id,{type:q.type,probabilities,confidence:mode==='oracle'?1:0,...(q.type==='choice'?{choice:mode==='oracle'?y:keys[0]}:{score:mode==='oracle'?y:(keys.length-1)/2})}];}))};}
