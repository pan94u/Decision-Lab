import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { adapterInput } from '../../domain/benchmark.mjs';
import { preflightPlan } from '../../application/plans.mjs';
import { ApplicationError } from '../../application/errors.mjs';
import { createClefAdapter } from '../adapters/clef.mjs';
import { fixtureAdapter } from '../adapters/fixture.mjs';

const providerCodes = new Set(['UPSTREAM_REDIRECT', 'UPSTREAM_REJECTED', 'INVALID_DECISION_RESPONSE']);
function resolveAdapter(plan, { environment, allowLive }) {
  preflightPlan(plan, { environment });
  if (plan.subject.adapter === 'controlled-fixture') return fixtureAdapter;
  if (!allowLive) throw new ApplicationError('LIVE_DISABLED', 'Live model execution was not enabled.');
  return createClefAdapter({ accountId: environment.CLOUDFLARE_ACCOUNT_ID,
    apiToken: environment[plan.subject.credentialRef.slice(4)], model: plan.subject.model });
}

// One independently supervised process per project. Storage, not this event loop, owns task state.
export async function runWorker({ store, projectId, environment = process.env, allowLive = false,
  once = false, leaseMs = 30000, pollMs = 250, signal, diagnostic = () => {}, adapterFactory = resolveAdapter }) {
  const ownerId = randomUUID(), allowedAdapters = allowLive ? ['controlled-fixture', 'cloudflare-native'] : ['controlled-fixture'];
  store.acquireWorker(projectId, ownerId, leaseMs);
  diagnostic({ type: 'WorkerStarted', projectId, workerId: ownerId, liveEnabled: allowLive });
  let active = null, controller = null, heartbeatFailure = null;
  const shutdown = () => controller?.abort();
  signal?.addEventListener('abort', shutdown);
  const heartbeat = setInterval(() => {
    try {
      store.pulse(projectId, ownerId, leaseMs, active);
      if (active) store.enforceDeadline(active.execution.experiment_id, projectId);
    } catch (error) {
      // Cancellation invalidates a task lease, while project ownership loss ends the process.
      if (error.message !== 'STALE_EXECUTION') heartbeatFailure = error;
      controller?.abort();
    }
  }, Math.max(10, Math.min(1000, Math.floor(leaseMs / 3))));

  function grade(claim) {
    const raw = store.savedOutput(claim);
    if (raw.providerError) {
      const code = providerCodes.has(raw.providerError.code) ? raw.providerError.code : 'INVALID_DECISION_RESPONSE';
      store.finishFailure(claim, code === 'INVALID_DECISION_RESPONSE' ? 'invalid' : 'failed', code);
    } else {
      store.recordAssessment(claim.attemptId, projectId, claim.plan.evaluation, undefined, claim);
      store.releaseExecution(claim);
    }
  }
  try {
    while (!signal?.aborted) {
      if (heartbeatFailure) throw heartbeatFailure;
      store.pulse(projectId, ownerId, leaseMs);
      // Recover at startup AND on subsequent polls; another process's task lease can expire later.
      for (const recovered of store.recover(projectId, ownerId, leaseMs)) {
        active = recovered;
        try { grade(recovered); }
        catch (error) {
          if (error.message !== 'STALE_EXECUTION') store.finishFailure(recovered, 'failed', 'EVALUATION_FAILED');
        } finally { active = null; }
      }
      const claim = store.claimNext(projectId, ownerId, leaseMs, allowedAdapters);
      if (!claim) {
        if (once) break;
        try { await delay(pollMs, undefined, { signal }); } catch { if (!signal?.aborted) throw Error('WORKER_WAIT_FAILED'); }
        continue;
      }
      active = claim; controller = new AbortController();
      let envelope, deadlineTimer, dispatched = false;
      try {
        const adapter = adapterFactory(claim.plan, { environment, allowLive });
        if (signal?.aborted) throw Error('WORKER_STOPPING');
        const authorization = store.authorizeInvocation(claim);
        if (!authorization.allowed) {
          store.transaction(() => store.stop(claim.execution.experiment_id, projectId, authorization.reason, claim.plan.actorId));
          continue;
        }
        deadlineTimer = setTimeout(() => {
          try { store.enforceDeadline(claim.execution.experiment_id, projectId); }
          catch (error) { heartbeatFailure = error; }
          controller?.abort();
        }, Math.max(1, authorization.deadlineMs - store.clock()));
        dispatched = true;
        envelope = await adapter(adapterInput(claim.plan.suite.cases.find(c => c.id === claim.execution.case_id), claim.plan.protocol, claim.plan.subject), { signal: controller.signal });
        // All built-in adapters implement a single-invocation harness. Preserve evidence before grading.
        store.enforceDeadline(claim.execution.experiment_id, projectId);
        store.recordResponse(claim, envelope);
        grade(claim);
        diagnostic({ type: 'ExecutionFinished', experimentId: claim.execution.experiment_id, executionId: claim.execution.id });
      } catch (error) {
        if (envelope) {
          // A response racing cancellation/lease expiry is evidence only; it cannot complete the task.
          store.saveLateResponse(claim, envelope);
        }
        const code = !dispatched ? (error instanceof ApplicationError ? error.code : 'ADAPTER_CONFIGURATION_ERROR')
          : envelope ? 'EVALUATION_FAILED' : 'INVOCATION_OUTCOME_UNKNOWN';
        try { store.finishFailure(claim, !dispatched ? 'blocked' : envelope ? 'failed' : 'outcome_unknown', code); }
        catch (stale) { if (!['STALE_EXECUTION', 'WORKER_LEASE_LOST'].includes(stale.message)) throw stale; }
        diagnostic({ type: 'ExecutionStopped', experimentId: claim.execution.experiment_id, code });
      } finally {
        clearTimeout(deadlineTimer);
        active = null; controller = null;
      }
    }
    if (heartbeatFailure) throw heartbeatFailure;
  } finally {
    clearInterval(heartbeat);
    signal?.removeEventListener('abort', shutdown);
    store.releaseWorker(projectId, ownerId);
    diagnostic({ type: 'WorkerStopped', projectId });
  }
}
