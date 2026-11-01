import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ExperimentStore } from '../../src/server/storage/experiment-store.mjs';

const options = Object.fromEntries(process.argv.slice(2).map((value, i, args) => value.startsWith('--') ? [value.slice(2), args[i + 1]] : null).filter(Boolean));
if (!options.packets || !options.db || !options.report) throw Error('Required: --packets FILE --db FILE --report FILE');
const packets = JSON.parse(await readFile(options.packets, 'utf8'));
const store = new ExperimentStore(options.db), reports = [];
let adapterCalls = 0;
try {
  for (const packet of packets) {
    const id = store.create(packet.plan, packet.idempotencyKey);
    for (const execution of store.get(id, packet.plan.projectId).executions) {
      if (execution.state !== 'queued') continue;
      await store.execute(execution.id, packet.plan.projectId, async request => {
        adapterCalls++;
        if (Object.hasOwn(request, 'reference') || Object.hasOwn(request.input, 'reference')) throw Error('REFERENCE_LEAK');
        const response = packet.responses[request.caseId];
        if (response === undefined) throw Error('MISSING_CONTROLLED_RESPONSE');
        return { output: response, invocations: packet.invocations?.[request.caseId] || [response] };
      });
    }
    reports.push({ packetId: packet.idempotencyKey, ...store.report(id, packet.plan.projectId) });
  }
} finally { store.close(); }
// Reopen the database before rescoring; verify.py also checks readback in another process.
const reopened = new ExperimentStore(options.db), checks = [];
try {
  for (const report of reports) {
    const read = reopened.get(report.experiment.id, report.experiment.projectId);
    const countBefore = read.executions.reduce((sum, e) => sum + e.attempts[0].assessments.length, 0);
    for (const execution of read.executions) reopened.recordAssessment(execution.attempts[0].id, read.projectId, read.snapshot.evaluation);
    const after = reopened.get(read.id, read.projectId);
    const countAfter = after.executions.reduce((sum, e) => sum + e.attempts[0].assessments.length, 0);
    checks.push({ experimentId: read.id, inputHashPreserved: read.planHash === report.experiment.planHash, assessmentsAdded: countAfter - countBefore, cases: read.executions.length });
  }
} finally { reopened.close(); }
await mkdir(dirname(options.report), { recursive: true });
await writeFile(options.report, JSON.stringify({ purpose: 'Architecture conformance with controlled responses, not model capability', adapterCalls, reports, persistenceChecks: checks }, null, 2));
console.log(JSON.stringify({ experiments: reports.length, adapterCalls, report: options.report }));
