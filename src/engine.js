export function validateTask(t) {
  if (!t || typeof t !== 'object' || typeof t.title !== 'string' || !t.title.trim() || t.title.length > 120) throw Error('任务需要 title，长度为 1–120 字符');
  if (typeof t.description !== 'string' || t.description.length > 12000) throw Error('任务需要 description（最多 12000 字符）');
  if (!Array.isArray(t.options) || t.options.length < 2 || t.options.length > 16) throw Error('每个任务必须包含 2–16 个候选行动');
  if (!t.budgets || typeof t.budgets !== 'object' || Array.isArray(t.budgets) || Object.keys(t.budgets).length < 1 || Object.keys(t.budgets).length > 6 || Object.values(t.budgets).some(v => !Number.isFinite(v) || v < 0)) throw Error('budgets 需要 1–6 个非负资源上限');
  const ids = t.options.map(o => o.id);
  if (ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(id)) || new Set(ids).size !== ids.length) throw Error('行动 id 必须唯一，只能使用字母、数字、下划线和连字符');
  for (const o of t.options) {
    if (typeof o.label !== 'string' || o.label.length > 200 || !Number.isFinite(o.value) || o.value < 0 || !o.costs || typeof o.costs !== 'object' || Array.isArray(o.costs)) throw Error('行动需要 label、非负 value 和 costs 对象');
    if (Object.entries(o.costs).some(([k,v]) => !Object.hasOwn(t.budgets,k) || !Number.isFinite(v) || v < 0)) throw Error('costs 必须引用 budgets 中的资源且非负');
    if (o.downside !== undefined && (!Number.isFinite(o.downside) || o.downside < 0 || o.downside > o.value)) throw Error('downside 必须介于 0 与 value 之间');
    for (const key of ['requires','excludes']) if (o[key] && (!Array.isArray(o[key]) || o[key].some(id => !ids.includes(id) || id === o.id))) throw Error(key + ' 包含无效行动引用');
  }
  if (t.required && (!Array.isArray(t.required) || t.required.some(id => !ids.includes(id)))) throw Error('required 包含无效行动引用');
  if (t.minSelect !== undefined && (!Number.isInteger(t.minSelect) || t.minSelect < 0 || t.minSelect > t.options.length)) throw Error('minSelect 无效');
  if (t.riskWeight !== undefined && (!Number.isFinite(t.riskWeight) || t.riskWeight < 0 || t.riskWeight > 1)) throw Error('riskWeight 必须介于 0 与 1 之间');
  return t;
}
export function inspect(t, selected) {
  const list = Array.isArray(selected) ? selected : [], ids = new Set(list), checks = [], usage = {};
  checks.push({name:'输出行动有效且无重复',pass:Array.isArray(selected) && ids.size === list.length && list.every(id => t.options.some(o => o.id === id))});
  let value=0,downside=0;
  for(const o of t.options.filter(o=>ids.has(o.id))) {value+=o.value;downside+=o.downside||0;for(const [k,v] of Object.entries(o.costs))usage[k]=(usage[k]||0)+v;}
  for(const [k,v] of Object.entries(t.budgets))checks.push({name:k+' ≤ '+v,pass:(usage[k]||0)<=v,actual:usage[k]||0,limit:v});
  for(const o of t.options) {
    if(o.requires?.length) checks.push({name:o.label+'：满足前置行动',pass:!ids.has(o.id)||o.requires.every(id=>ids.has(id))});
    if(o.excludes?.length) checks.push({name:o.label+'：满足互斥限制',pass:!ids.has(o.id)||o.excludes.every(id=>!ids.has(id))});
  }
  for(const id of t.required||[]) checks.push({name:'必选：'+t.options.find(o=>o.id===id).label,pass:ids.has(id)});
  if(t.minSelect)checks.push({name:'至少选择 '+t.minSelect+' 个行动',pass:ids.size>=t.minSelect});
  return {feasible:checks.every(c=>c.pass),checks,usage,value,downside,objective:value-(t.riskWeight||0)*downside};
}
export function solve(t) {
  const n=t.options.length;let best=null;
  // Exact enumeration is bounded at 16 options for imported tasks.
  for(let mask=0;mask<2**n;mask++) {
    let value=0,downside=0,count=0,valid=true;const usage={};
    for(let i=0;i<n;i++)if(mask&(1<<i)){const o=t.options[i];count++;value+=o.value;downside+=o.downside||0;for(const [k,v] of Object.entries(o.costs)){usage[k]=(usage[k]||0)+v;if(usage[k]>t.budgets[k]){valid=false;break;}}if(!valid)break;}
    if(!valid || count<(t.minSelect||0))continue;
    const objective=value-(t.riskWeight||0)*downside;if(best&&objective<=best.objective)continue;
    const selected=t.options.filter((_,i)=>mask&(1<<i)).map(o=>o.id),s=new Set(selected);
    if((t.required||[]).some(id=>!s.has(id)))continue;
    if(t.options.some(o=>s.has(o.id)&&((o.requires||[]).some(id=>!s.has(id))||(o.excludes||[]).some(id=>s.has(id)))))continue;
    best={selected,objective};
  }
  if(!best)throw Error('该任务没有满足全部约束的可行解');
  return best;
}
export function grade(t, selected) {const actual=inspect(t,selected),optimum=solve(t);return {...actual,optimum,score:actual.feasible?Math.round((optimum.objective===0?1:Math.max(0,actual.objective)/optimum.objective)*1000)/10:0};}
export function demo(t,mode='greedy') {
  if(mode==='optimal')return {selected:solve(t).selected,reason:'精确枚举所有行动组合，选取满足硬约束且风险调整收益最高的方案。这是求解器基线，不是模型输出。'};
  const sorted=[...t.options].sort((a,b)=>(b.value-(t.riskWeight||0)*(b.downside||0))/(1+Object.values(b.costs).reduce((a,b)=>a+b,0))-(a.value-(t.riskWeight||0)*(a.downside||0))/(1+Object.values(a.costs).reduce((a,b)=>a+b,0)));
  let selected=[...(t.required||[])];
  for(const o of sorted) {if(selected.includes(o.id))continue;const next=[...new Set([...selected,...(o.requires||[]),o.id])];if(inspect({...t,minSelect:0},next).feasible)selected=next;}
  return {selected,reason:'按风险调整收益 /（1 + 资源成本合计）从高到低贪心选择，并检查依赖、互斥与预算。这是确定性启发式基线，不是真实模型推理。'};
}
export function parseDecision(raw) {
  if(typeof raw !== 'string')throw Error('模型未返回文本');
  let clean=raw.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
  let parsed;try{parsed=JSON.parse(clean);}catch{throw Error('输出不是有效 JSON，请返回 {"selected":["行动ID"],"reason":"简短决策依据"}');}
  if(!parsed || !Array.isArray(parsed.selected) || parsed.selected.some(x=>typeof x!=='string'))throw Error('输出缺少 selected 字符串数组');
  return {selected:parsed.selected,reason:typeof parsed.reason==='string'?parsed.reason:''};
}
