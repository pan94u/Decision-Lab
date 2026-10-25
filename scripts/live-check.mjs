import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { seeds } from '../src/seeds.js';
import { grade, summarize } from '../src/engine.js';
const env = new URL('../.env', import.meta.url);
if (existsSync(env)) loadEnvFile(env);
const base = `http://localhost:${process.env.PORT || 4173}`;
try {
  const h = await (await fetch(base + '/api/health')).json();
  if (!h.cloudflareConfigured) throw Error('未配置有效的 Cloudflare 凭据');
} catch (e) { console.error(`无法开始真实验收：${e.message}。先运行 npm run setup 和 npm run dev。`); process.exit(1); }
const runs = [];
for (const model of ['clef', 'clef-flash']) {
  const run = { id: crypto.randomUUID(), name: `${model} · 本地真实验收`, model, demo: false, config: { type: 'cloudflare', model }, created: new Date().toISOString(), status: 'running', results: [] };
  for (const task of seeds) {
    const x = { task: structuredClone(task), repeat: 1, status: 'pending' };
    try {
      const res = await fetch(base + '/api/infer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: run.config, task }), signal: AbortSignal.timeout(70000) });
      const data = await res.json();
      if (!res.ok) throw Error(data.error || `HTTP ${res.status}`);
      Object.assign(x, { raw: data.raw, latency: data.latency, usage: data.usage, actualModel: data.model, grade: grade(task, data.response), status: 'done' });
      console.log(model, task.id, x.grade.score.toFixed(1) + '%', data.latency + 'ms');
    } catch (e) { x.status = 'error'; x.error = e.message; console.log(model, task.id, 'ERROR', e.message); }
    run.results.push(x);
  }
  run.finished = new Date().toISOString();
  run.status = run.results.some(x => x.status === 'error') ? 'failed' : 'completed';
  runs.push(run);
  const m = summarize(run.results);
  console.log('SUMMARY', JSON.stringify({ model, completed: run.results.filter(x => x.status === 'done').length, total: run.results.length, accuracy: m.accuracy, brier: m.brier }));
}
const filename = `artifacts/live-check-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL('../' + filename, import.meta.url), JSON.stringify({ runs }, null, 2));
console.log(`Saved ${filename}. Historical seed records were not modified.`);
if (runs.some(r => r.status === 'failed')) process.exitCode = 1;
