import { ExperimentStore } from '../../src/server/storage/experiment-store.mjs';
const [database, ids] = process.argv.slice(2);
const store = new ExperimentStore(database);
try { console.log(JSON.stringify(JSON.parse(ids).map(({id,projectId})=>{const e=store.get(id,projectId);return{id:e.id,planHash:e.planHash,cases:e.executions.length,assessmentCount:e.executions.reduce((n,x)=>n+x.attempts[0].assessments.length,0)};}))); }
finally { store.close(); }
