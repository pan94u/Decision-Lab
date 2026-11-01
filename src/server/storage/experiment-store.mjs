import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, fingerprint, validatePlan, adapterInput, assess, aggregate } from '../../domain/benchmark.mjs';

const now = () => new Date().toISOString();
export class ExperimentStore {
  constructor(path, { readOnly = false } = {}) {
    if (!readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { readOnly });
    if (!readOnly && path !== ':memory:') chmodSync(path, 0o600);
    if (readOnly) { this.db.exec('PRAGMA busy_timeout=5000;'); return; }
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS experiments(
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, actor_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL, plan_hash TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
          UNIQUE(project_id,idempotency_key));
        CREATE TABLE IF NOT EXISTS executions(
          id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id), case_id TEXT NOT NULL,
          trial INTEGER NOT NULL, state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
          UNIQUE(experiment_id,case_id,trial));
        CREATE TABLE IF NOT EXISTS attempts(
          id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id), attempt_no INTEGER NOT NULL,
          generation INTEGER NOT NULL, state TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL,
          UNIQUE(execution_id,attempt_no));
        CREATE TABLE IF NOT EXISTS observations(
          id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id), raw TEXT NOT NULL,
          raw_hash TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS invocations(
          id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), ordinal INTEGER NOT NULL,
          raw TEXT NOT NULL, raw_hash TEXT NOT NULL, UNIQUE(attempt_id,ordinal));
        CREATE TABLE IF NOT EXISTS assessments(
          id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), evaluation TEXT NOT NULL,
          evaluation_hash TEXT NOT NULL, result TEXT NOT NULL, result_hash TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(
          id INTEGER PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id),
          actor_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      `);
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(1,?)').run(now());
    });
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
  create(plan, idempotencyKey) {
    validatePlan(plan);
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) throw Error('Idempotency key is required');
    const snapshot = canonical(plan), hash = fingerprint(plan);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id,plan_hash FROM experiments WHERE project_id=? AND idempotency_key=?').get(plan.projectId, idempotencyKey);
      if (existing) { if (existing.plan_hash !== hash) throw Error('IDEMPOTENCY_CONFLICT'); return existing.id; }
      const id = randomUUID();
      this.db.prepare('INSERT INTO experiments VALUES(?,?,?,?,?,?,?)').run(id, plan.projectId, plan.actorId, idempotencyKey, hash, snapshot, now());
      const insert = this.db.prepare('INSERT INTO executions(id,experiment_id,case_id,trial,state) VALUES(?,?,?,?,?)');
      for (const c of plan.suite.cases) for (let trial = 0; trial < (plan.repeats || 1); trial++) insert.run(randomUUID(), id, c.id, trial, 'queued');
      this.onCreated?.(id, plan);
      this.event(id, plan.actorId, 'ExperimentCreated', { planHash: hash });
      return id;
    });
  }
  event(experimentId, actorId, type, payload) {
    this.db.prepare('INSERT INTO events(experiment_id,actor_id,type,payload,created_at) VALUES(?,?,?,?,?)').run(experimentId, actorId, type, canonical(payload), now());
  }
  get(id, projectId) {
    const row = this.db.prepare('SELECT * FROM experiments WHERE id=? AND project_id=?').get(id, projectId);
    if (!row) throw Error('NOT_FOUND');
    const snapshot = JSON.parse(row.snapshot);
    if (fingerprint(snapshot) !== row.plan_hash) throw Error('SNAPSHOT_INTEGRITY_ERROR');
    const executions = this.db.prepare('SELECT * FROM executions WHERE experiment_id=? ORDER BY case_id,trial').all(id).map(execution => ({
      ...execution,
      attempts: this.db.prepare('SELECT * FROM attempts WHERE execution_id=? ORDER BY attempt_no').all(execution.id).map(attempt => {
        const observation = this.db.prepare('SELECT * FROM observations WHERE attempt_id=?').get(attempt.id);
        if (observation && fingerprint(JSON.parse(observation.raw)) !== observation.raw_hash) throw Error('EVIDENCE_INTEGRITY_ERROR');
        const invocations = this.db.prepare('SELECT * FROM invocations WHERE attempt_id=? ORDER BY ordinal').all(attempt.id);
        if (invocations.some(x => fingerprint(JSON.parse(x.raw)) !== x.raw_hash)) throw Error('INVOCATION_INTEGRITY_ERROR');
        const assessments = this.db.prepare('SELECT * FROM assessments WHERE attempt_id=? ORDER BY rowid').all(attempt.id);
        if (assessments.some(x => fingerprint(JSON.parse(x.result)) !== x.result_hash || fingerprint(JSON.parse(x.evaluation)) !== x.evaluation_hash)) throw Error('ASSESSMENT_INTEGRITY_ERROR');
        return { ...attempt, observation: observation ? { ...observation, raw: JSON.parse(observation.raw) } : null,
          invocations: invocations.map(x => ({ ...x, raw: JSON.parse(x.raw) })),
          assessments: assessments.map(x => ({ ...x, evaluation: JSON.parse(x.evaluation), result: JSON.parse(x.result) })) };
      }) }));
    return { id: row.id, projectId: row.project_id, actorId: row.actor_id, createdAt: row.created_at, planHash: row.plan_hash, snapshot, executions };
  }
  claim(executionId, projectId) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT e.*,p.actor_id,p.snapshot FROM executions e JOIN experiments p ON p.id=e.experiment_id WHERE e.id=? AND p.project_id=?').get(executionId, projectId);
      if (!row) throw Error('NOT_FOUND');
      if (row.state !== 'queued') throw Error('EXECUTION_NOT_QUEUED');
      const generation = row.generation + 1, id = randomUUID();
      this.db.prepare('UPDATE executions SET state=?,generation=? WHERE id=?').run('running', generation, row.id);
      this.db.prepare('INSERT INTO attempts(id,execution_id,attempt_no,generation,state,created_at) VALUES(?,?,?,?,?,?)').run(id, row.id, 1, generation, 'requesting', now());
      this.event(row.experiment_id, row.actor_id, 'AttemptStarted', { executionId, attemptId: id, generation });
      return { attemptId: id, generation, execution: row, plan: JSON.parse(row.snapshot) };
    });
  }
  recordResponse(claim, envelope) {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT state,generation FROM executions WHERE id=?').get(claim.execution.id);
      if (current.state !== 'running' || current.generation !== claim.generation) throw Error('STALE_EXECUTION');
      if (claim.ownerId) this.assertLease(claim);
      const calls = this.insertEnvelope(claim.attemptId, envelope);
      this.db.prepare('UPDATE attempts SET state=? WHERE id=?').run('response_saved', claim.attemptId);
      this.event(claim.execution.experiment_id, claim.plan.actorId, 'ResponseRecorded', { attemptId: claim.attemptId, invocations: calls.length });
    });
  }
  insertEnvelope(attemptId, envelope) {
    this.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?)').run(randomUUID(), attemptId, canonical(envelope.output), fingerprint(envelope.output), now());
    const calls = envelope.invocations || [envelope.output];
    if (!Array.isArray(calls)) throw Error('Invalid invocation list');
    const insert = this.db.prepare('INSERT INTO invocations VALUES(?,?,?,?,?)');
    calls.forEach((call, index) => insert.run(randomUUID(), attemptId, index, canonical(call), fingerprint(call)));
    return calls;
  }
  recordAssessment(attemptId, projectId, evaluation, evaluator = assess, authority) {
    const attempt = this.db.prepare('SELECT a.*,e.experiment_id,e.case_id,e.generation AS current_generation,e.state AS execution_state,p.snapshot FROM attempts a JOIN executions e ON a.execution_id=e.id JOIN experiments p ON e.experiment_id=p.id WHERE a.id=? AND p.project_id=?').get(attemptId, projectId);
    if (!attempt) throw Error('NOT_FOUND');
    if (attempt.current_generation !== attempt.generation || !['running','succeeded','failed','invalid'].includes(attempt.execution_state)) throw Error('STALE_EXECUTION');
    const observation = this.db.prepare('SELECT * FROM observations WHERE attempt_id=?').get(attemptId);
    if (!observation) throw Error('NO_RESPONSE_TO_EVALUATE');
    const plan = JSON.parse(attempt.snapshot), c = plan.suite.cases.find(x => x.id === attempt.case_id);
    if (fingerprint(JSON.parse(observation.raw)) !== observation.raw_hash) throw Error('EVIDENCE_INTEGRITY_ERROR');
    // Evaluator exceptions happen after the response transaction committed.
    const result = evaluator(c, JSON.parse(observation.raw), evaluation), id = randomUUID();
    this.transaction(() => {
      const current = this.db.prepare('SELECT generation,state FROM executions WHERE id=?').get(attempt.execution_id);
      if (current.generation !== attempt.generation || !['running','succeeded','failed','invalid'].includes(current.state)) throw Error('STALE_EXECUTION');
      if (authority) this.assertLease(authority);
      this.db.prepare('INSERT INTO assessments VALUES(?,?,?,?,?,?,?)').run(id, attemptId, canonical(evaluation), fingerprint(evaluation), canonical(result), fingerprint(result), now());
      this.db.prepare('UPDATE attempts SET state=?,error=NULL WHERE id=?').run('evaluated', attemptId);
      this.db.prepare('UPDATE executions SET state=? WHERE id=?').run(result.status === 'valid' ? 'succeeded' : 'invalid', attempt.execution_id);
      this.event(attempt.experiment_id, plan.actorId, 'AssessmentRecorded', { attemptId, assessmentId: id, evaluationHash: fingerprint(evaluation) });
    });
    return result;
  }
  async execute(executionId, projectId, adapter, { evaluator = assess, evaluation } = {}) {
    const claim = this.claim(executionId, projectId), c = claim.plan.suite.cases.find(x => x.id === claim.execution.case_id);
    try {
      const envelope = await adapter(adapterInput(c, claim.plan.protocol, claim.plan.subject));
      this.recordResponse(claim, envelope);
      return this.recordAssessment(claim.attemptId, projectId, evaluation || claim.plan.evaluation, evaluator);
    } catch (e) {
      // Stable diagnostics only; do not persist arbitrary exception text that could contain secrets.
      this.transaction(() => {
        this.db.prepare('UPDATE attempts SET error=? WHERE id=?').run('EXECUTION_OR_EVALUATION_ERROR', claim.attemptId);
        this.db.prepare("UPDATE executions SET state='failed' WHERE id=? AND generation=?").run(executionId, claim.generation);
        this.event(claim.execution.experiment_id, claim.plan.actorId, 'AttemptFailed', { attemptId: claim.attemptId, hasSavedResponse: !!this.db.prepare('SELECT id FROM observations WHERE attempt_id=?').get(claim.attemptId) });
      });
      throw e;
    }
  }
  report(id, projectId) {
    const experiment = this.get(id, projectId);
    const results = experiment.executions.flatMap(x => x.attempts.slice(-1).flatMap(a => a.assessments.slice(-1).map(v => v.result)));
    return { experiment, executionCounts: { planned: experiment.executions.length, assessed: results.length, states: Object.fromEntries(['queued','running','succeeded','failed','invalid','blocked','cancelled','budget_exhausted','outcome_unknown'].map(state=>[state,experiment.executions.filter(x=>x.state===state).length])) }, summary: { scope: 'assessed executions only; pending/unassessed are not hidden', ...aggregate(results) } };
  }
}
