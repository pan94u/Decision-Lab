import { preflightPlan } from './plans.mjs';
import { ApplicationError, publicError } from './errors.mjs';

// Transport-independent use cases. A UI/API can use the same service and repository.
export class ExperimentService {
  constructor({ openStore, environment = {} }) {
    this.openStore = openStore;
    this.environment = environment;
  }
  validate(plan, { projectId } = {}) {
    return preflightPlan(plan, { projectId, environment: this.environment }).validation;
  }
  create(plan, { projectId, idempotencyKey }) {
    if (typeof projectId !== 'string' || !projectId.trim()) throw new ApplicationError('PROJECT_REQUIRED', 'Explicit project context is required.');
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 256) throw new ApplicationError('INVALID_IDEMPOTENCY_KEY', 'A nonempty idempotency key of at most 256 characters is required.');
    const checked = preflightPlan(plan, { projectId, environment: this.environment });
    return this.withStore('create', store => {
      const id = store.create(checked.plan, idempotencyKey);
      return { ...this.describe(store.get(id, projectId)), validation: checked.validation };
    });
  }
  get(id, { projectId }) {
    if (typeof id !== 'string' || !id.trim() || typeof projectId !== 'string' || !projectId.trim()) throw new ApplicationError('CONTEXT_REQUIRED', 'Experiment ID and project context are required.');
    return this.withStore('get', store => this.describe(store.get(id, projectId)));
  }
  cancel(id, { projectId, actorId }) {
    if (typeof id !== 'string' || !id.trim() || typeof projectId !== 'string' || !projectId.trim() || typeof actorId !== 'string' || !actorId.trim() || actorId.length > 256) {
      throw new ApplicationError('CONTEXT_REQUIRED', 'Experiment ID, project and cancellation actor are required.');
    }
    return this.withStore('cancel', store => this.describe(store.cancel(id, projectId, actorId)));
  }
  withStore(operation, fn) {
    let store;
    try { store = this.openStore(operation); return fn(store); }
    catch (error) { throw publicError(error); }
    finally { store?.close(); }
  }
  describe(experiment) {
    const counts = {};
    for (const item of experiment.executions) counts[item.state] = (counts[item.state] || 0) + 1;
    return {
      kind: 'experiment', experimentId: experiment.id, projectId: experiment.projectId, actorId: experiment.actorId,
      createdAt: experiment.createdAt, planHash: experiment.planHash,
      state: counts.queued === experiment.executions.length ? 'queued' : counts.running || counts.queued ? 'in_progress' : 'completed',
      executionCounts: { planned: experiment.executions.length, states: counts },
      versions: Object.fromEntries(['suite', 'subject', 'protocol', 'evaluation'].map(key => [key, { id: experiment.snapshot[key].id, revision: experiment.snapshot[key].revision }])),
      attentionRequired: experiment.executions.some(e => ['outcome_unknown', 'blocked', 'failed', 'invalid'].includes(e.state)),
      control: experiment.control ? {
        startedAt: experiment.control.started_ms === null ? null : new Date(experiment.control.started_ms).toISOString(),
        deadlineAt: experiment.control.deadline_ms === null ? null : new Date(experiment.control.deadline_ms).toISOString(),
        reservedInvocations: experiment.control.reserved_invocations, stopReason: experiment.control.stop_reason,
      } : null,
      // No reference evidence or response bodies in routine status output.
      executions: experiment.executions.map(e => ({ id: e.id, caseId: e.case_id, trial: e.trial, state: e.state,
        attempts: e.attempts.map(a => ({ id: a.id, state: a.state, error: a.error, hasSavedResponse: !!a.observation,
          invocations: a.invocations.length, assessments: a.assessments.length })),
      })),
    };
  }
}
