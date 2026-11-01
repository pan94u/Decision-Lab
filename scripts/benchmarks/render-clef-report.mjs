import { readFile, writeFile } from 'node:fs/promises';
const root=new URL('../../',import.meta.url),directory=new URL('artifacts/clef-benchmark/',root);
const report=JSON.parse(await readFile(new URL('report.json',directory),'utf8'));
const percentage=x=>x===null?'—':(x*100).toFixed(2)+'%';
const lines=['# CLEF 真实模型基准子集实测','',`开始时间：${report.startedAt}。模型：\`@cf/cloudflare/${report.model}\`。`,
 '',`发出 ${report.requestsSent} 个真实请求，无自动重试。以下均为派生协议和确定选取的小样本，不是完整官方 benchmark 复现。`,
 '', '| 数据集 | 样例 | 正确 | 有效答案 | 准确率 | 平均响应头耗时 |', '| --- | ---: | ---: | ---: | ---: | ---: |'];
for(const r of report.reports){const m=r.metrics;lines.push(`| ${r.benchmark} | ${m.plannedCases} | ${m.correct} | ${m.validAnswers} | ${percentage(m.endToEndAccuracy)} | ${(m.averageLatencyMs/1000).toFixed(3)} 秒 |`);}
lines.push('','耗时从请求开始计至响应头到达，不含响应正文读取；报告中的 averageLatencyMs 使用该口径。未报告费用估计。','', '## 适配与范围','',
 '- MMLU：4 个 abstract_algebra 测试样例，保留原五条 few-shot 示例，改用原生 choice schema；候选概率不是原始 token-logprob 协议。',
 '- CLINC：3 条域内、3 条域外样例，使用完整 150 意图 + oos 标签空间；仅据标签名生成描述。',
 '- IFEval：未运行。CLEF 不生成该基准所需的自由文本，不能用选择题替换后声称是 IFEval 成绩。',
 '- 当前结果不能外推总体表现；完整原始请求/响应、协议快照及逐题评价存于 SQLite 和 report.json，凭据不进入报告。','', '## 逐题结果','',
 '| 样例 | 参考 | CLEF | 命中 | 选中概率 | 参考概率 |', '| --- | --- | --- | --- | ---: | ---: |');
for(const r of report.reports)for(const d of r.details)lines.push(`| ${d.caseId} | ${d.expected} | ${d.predicted??'—'} | ${d.correct?'是':'否'} | ${percentage(d.selectedProbability)} | ${percentage(d.probabilityOfExpected)} |`);
lines.push('','## 概率与用量','');
for(const r of report.reports){const m=r.metrics;lines.push(`- ${r.benchmark}：normalized Brier = ${m.normalizedBrier?.toFixed(6)??'—'}；NLL = ${m.nll?.toFixed(6)??'—'}。`);if(m.oosRecall!==undefined)lines.push(`- 域外召回：${percentage(m.oosRecall)}（仅 3 条）；域内准确率：${percentage(m.inScopeAccuracy)}（仅 3 条）。`);}
const inputTokens=report.reports.flatMap(r=>r.metrics.providerUsage).reduce((n,u)=>n+(u.input_tokens||0),0);
lines.push(`- 提供商记录的输入 token 合计：${inputTokens}。接口 usage 原值保存在完整报告中。`,'');
await writeFile(new URL('report.md',directory),lines.join('\n'));
const summary={purpose:report.purpose,startedAt:report.startedAt,model:report.model,requestsSent:report.requestsSent,stoppedEarly:report.stoppedEarly,
 latencyMeasurement:'request start to response headers; excludes body read',inputTokens,skipped:report.skipped,
 reports:report.reports.map(r=>({benchmark:r.benchmark,experimentId:r.experimentId,planHash:r.planHash,protocol:r.protocol,metrics:r.metrics,details:r.details})),
 limitations:['Deterministic small subsets; not official full benchmark scores.','MMLU native choice probabilities are not the original token-logprob scoring protocol.','CLINC uses all 151 labels but only 6 source examples.','IFEval generation was not run.']};
await writeFile(new URL('benchmarks/clef-live-summary.json',root),JSON.stringify(summary,null,2)+'\n');
console.log('Saved artifacts/clef-benchmark/report.md and benchmarks/clef-live-summary.json');
