import { randomUUID } from 'node:crypto';
import { ExperimentStore } from './experiment-store.mjs';
import { fingerprint } from '../../domain/benchmark.mjs';

// Additive v2 migration; legacy experiments remain readable and are never picked by this Worker.
export class RuntimeStore extends ExperimentStore {
  constructor(path, { readOnly = false, clock = Date.now } = {}) {
    super(path, { readOnly });
    this.clock = clock;
    if (readOnly) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS experiment_control(
          experiment_id TEXT PRIMARY KEY REFERENCES experiments(id),
          started_ms INTEGER, deadline_ms INTEGER, reserved_invocations INTEGER NOT NULL DEFAULT 0,
          stop_reason TEXT, stopped_ms INTEGER);
        CREATE TABLE IF NOT EXISTS execution_leases(
          execution_id TEXT PRIMARY KEY REFERENCES executions(id), owner_id TEXT NOT NULL, expires_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS worker_locks(
          project_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_ms INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS execution_queue ON executions(state,experiment_id);
        INSERT OR IGNORE INTO experiment_control(experiment_id)
          SELECT id FROM experiments WHERE json_extract(snapshot,'$.schemaVersion')='decision-lab.plan/v1';
      `);
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(2,?)').run(new Date(this.clock()).toISOString());
    });
  }
  onCreated(id, plan) {
    if (plan.schemaVersion === 'decision-lab.plan/v1') this.db.prepare('INSERT INTO experiment_control(experiment_id) VALUES(?)').run(id);
  }
  get(id, projectId) {
    const result = super.get(id, projectId);
    const migrated = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='experiment_control'").get();
    result.control = migrated ? this.db.prepare('SELECT * FROM experiment_control WHERE experiment_id=?').get(id) || null : null;
    return result;
  }
  savedOutput(claim) {
    const row = this.db.prepare(`SELECT o.* FROM observations o JOIN attempts a ON a.id=o.attempt_id
      JOIN executions e ON e.id=a.execution_id JOIN experiments p ON p.id=e.experiment_id
      WHERE a.id=? AND e.id=? AND p.project_id=?`).get(claim.attemptId, claim.execution.id, claim.plan.projectId);
    if (!row) throw Error('NO_RESPONSE_TO_EVALUATE');
    const raw = JSON.parse(row.raw);
    if (fingerprint(raw) !== row.raw_hash) throw Error('EVIDENCE_INTEGRITY_ERROR');
    return raw;
  }
  acquireWorker(projectId, ownerId, leaseMs) {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM worker_locks WHERE project_id=?').get(projectId);
      if (row && row.expires_ms > this.clock()) throw Error('WORKER_BUSY');
      this.db.prepare('INSERT OR REPLACE INTO worker_locks VALUES(?,?,?)').run(projectId, ownerId, this.clock() + leaseMs);
    });
  }
  assertWorker(projectId, ownerId) {
    const row = this.db.prepare('SELECT * FROM worker_locks WHERE project_id=? AND owner_id=?').get(projectId, ownerId);
    if (!row || row.expires_ms <= this.clock()) throw Error('WORKER_LEASE_LOST');
  }
  assertLease(claim) {
    this.assertWorker(claim.plan.projectId, claim.ownerId);
    const row = this.db.prepare('SELECT l.*,e.state,e.generation FROM execution_leases l JOIN executions e ON e.id=l.execution_id WHERE execution_id=?').get(claim.execution.id);
    if (!row || row.owner_id !== claim.ownerId || row.expires_ms <= this.clock() || row.generation !== claim.generation || row.state !== 'running') throw Error('STALE_EXECUTION');
  }
  pulse(projectId, ownerId, leaseMs, claim) {
    return this.transaction(() => {
      this.assertWorker(projectId, ownerId);
      this.db.prepare('UPDATE worker_locks SET expires_ms=? WHERE project_id=? AND owner_id=?').run(this.clock() + leaseMs, projectId, ownerId);
      if (!claim) return true;
      this.assertLease(claim);
      this.db.prepare('UPDATE execution_leases SET expires_ms=? WHERE execution_id=? AND owner_id=?').run(this.clock() + leaseMs, claim.execution.id, ownerId);
      return true;
    });
  }
  releaseWorker(projectId, ownerId) {
    this.db.prepare('DELETE FROM worker_locks WHERE project_id=? AND owner_id=?').run(projectId, ownerId);
  }
  // Called within a transaction. A stop invalidates every current owner before it returns.
  stop(id, projectId, reason, actorId) {
    const row = this.db.prepare('SELECT * FROM experiments WHERE id=? AND project_id=?').get(id, projectId);
    if (!row) throw Error('NOT_FOUND');
    const control = this.db.prepare('SELECT * FROM experiment_control WHERE experiment_id=?').get(id);
    if (!control) throw Error('LEGACY_EXECUTION_UNSUPPORTED');
    if (control.stop_reason) return;
    const active = this.db.prepare("SELECT * FROM executions WHERE experiment_id=? AND state IN ('queued','running')").all(id);
    if (!active.length) return;
    this.db.prepare('UPDATE experiment_control SET stop_reason=?,stopped_ms=? WHERE experiment_id=?').run(reason, this.clock(), id);
    const state = reason === 'cancelled' ? 'cancelled' : 'budget_exhausted';
    for (const execution of active) {
      if (execution.state === 'running') {
        const attempt = this.db.prepare('SELECT * FROM attempts WHERE execution_id=? ORDER BY attempt_no DESC LIMIT 1').get(execution.id);
        if (attempt) {
          const saved = this.db.prepare('SELECT id FROM observations WHERE attempt_id=?').get(attempt.id);
          const status = saved ? 'response_saved' : attempt.state === 'claimed' ? 'stopped_before_dispatch' : 'outcome_unknown';
          this.db.prepare('UPDATE attempts SET state=?,error=? WHERE id=?').run(status, reason.toUpperCase(), attempt.id);
        }
      }
      this.db.prepare('UPDATE executions SET state=?,generation=generation+1 WHERE id=?').run(state, execution.id);
      this.db.prepare('DELETE FROM execution_leases WHERE execution_id=?').run(execution.id);
    }
    this.event(id, actorId, 'ExperimentStopped', { reason, affectedExecutions: active.length });
  }
  cancel(id, projectId, actorId) {
    this.transaction(() => this.stop(id, projectId, 'cancelled', actorId));
    return this.get(id, projectId);
  }
  enforceDeadline(id, projectId) {
    return this.transaction(() => {
      const c = this.db.prepare('SELECT c.*,p.actor_id FROM experiment_control c JOIN experiments p ON p.id=c.experiment_id WHERE c.experiment_id=? AND p.project_id=?').get(id, projectId);
      if (!c) throw Error('NOT_FOUND');
      if (c.deadline_ms !== null && c.deadline_ms <= this.clock()) this.stop(id, projectId, 'runtime_exceeded', c.actor_id);
    });
  }
  claimNext(projectId, ownerId, leaseMs, allowedAdapters) {
    return this.transaction(() => {
      this.assertWorker(projectId, ownerId);
      if (this.db.prepare("SELECT 1 FROM executions e JOIN experiments p ON p.id=e.experiment_id JOIN execution_leases l ON l.execution_id=e.id WHERE p.project_id=? AND e.state='running' LIMIT 1").get(projectId)) return null;
      const rows = this.db.prepare(`SELECT e.*,p.snapshot,p.plan_hash,p.actor_id FROM executions e JOIN experiments p ON p.id=e.experiment_id
        JOIN experiment_control c ON c.experiment_id=p.id WHERE p.project_id=? AND e.state='queued' AND c.stop_reason IS NULL ORDER BY p.created_at,e.rowid`).all(projectId);
      for (const row of rows) {
        const plan = JSON.parse(row.snapshot);
        if (fingerprint(plan) !== row.plan_hash) throw Error('SNAPSHOT_INTEGRITY_ERROR');
        if (!allowedAdapters.includes(plan.subject.adapter)) continue;
        const control = this.db.prepare('SELECT * FROM experiment_control WHERE experiment_id=?').get(row.experiment_id);
        if (control.stop_reason) continue;
        if (control.deadline_ms !== null && control.deadline_ms <= this.clock()) { this.stop(row.experiment_id, projectId, 'runtime_exceeded', row.actor_id); continue; }
        if (control.reserved_invocations >= plan.budget.maxInvocations) { this.stop(row.experiment_id, projectId, 'call_budget_exceeded', row.actor_id); continue; }
        const generation = row.generation + 1, attemptId = randomUUID();
        const attemptNo = this.db.prepare('SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM attempts WHERE execution_id=?').get(row.id).n;
        this.db.prepare("UPDATE executions SET state='running',generation=? WHERE id=?").run(generation, row.id);
        this.db.prepare("INSERT INTO attempts(id,execution_id,attempt_no,generation,state,created_at) VALUES(?,?,?,?,'claimed',?)").run(attemptId, row.id, attemptNo, generation, new Date(this.clock()).toISOString());
        this.db.prepare('INSERT OR REPLACE INTO execution_leases VALUES(?,?,?)').run(row.id, ownerId, this.clock() + leaseMs);
        this.event(row.experiment_id, row.actor_id, 'ExecutionClaimed', { executionId: row.id, attemptId, generation, workerId: ownerId });
        return { attemptId, generation, execution: row, plan, ownerId };
      }
      return null;
    });
  }
  authorizeInvocation(claim) {
    return this.transaction(() => {
      this.assertLease(claim);
      const attempt = this.db.prepare('SELECT state FROM attempts WHERE id=?').get(claim.attemptId);
      if (attempt.state !== 'claimed') throw Error('INVOCATION_ALREADY_AUTHORIZED');
      const c = this.db.prepare('SELECT * FROM experiment_control WHERE experiment_id=?').get(claim.execution.experiment_id);
      if (c.stop_reason) throw Error('STALE_EXECUTION');
      if (c.deadline_ms !== null && c.deadline_ms <= this.clock()) return { allowed: false, reason: 'runtime_exceeded' };
      if (c.reserved_invocations >= claim.plan.budget.maxInvocations) return { allowed: false, reason: 'call_budget_exceeded' };
      const started = c.started_ms ?? this.clock(), deadline = c.deadline_ms ?? started + claim.plan.budget.maxRuntimeMs;
      this.db.prepare('UPDATE experiment_control SET started_ms=?,deadline_ms=?,reserved_invocations=reserved_invocations+1 WHERE experiment_id=?').run(started, deadline, claim.execution.experiment_id);
      this.db.prepare("UPDATE attempts SET state='requesting' WHERE id=?").run(claim.attemptId);
      this.event(claim.execution.experiment_id, claim.plan.actorId, 'InvocationAuthorized', { attemptId: claim.attemptId, workerId: claim.ownerId, reservedInvocations: c.reserved_invocations + 1 });
      return { allowed: true, deadlineMs: deadline };
    });
  }
  finishFailure(claim, state, code) {
    this.transaction(() => {
      this.assertLease(claim);
      this.db.prepare('UPDATE attempts SET state=?,error=? WHERE id=?').run(state, code, claim.attemptId);
      this.db.prepare('UPDATE executions SET state=? WHERE id=?').run(state, claim.execution.id);
      this.db.prepare('DELETE FROM execution_leases WHERE execution_id=?').run(claim.execution.id);
      this.event(claim.execution.experiment_id, claim.plan.actorId, 'ExecutionStopped', { attemptId: claim.attemptId, state, code });
    });
  }
  releaseExecution(claim) {
    this.db.prepare('DELETE FROM execution_leases WHERE execution_id=? AND owner_id=?').run(claim.execution.id, claim.ownerId);
  }
  saveLateResponse(claim, envelope) {
    this.transaction(() => {
      const attempt = this.db.prepare('SELECT id FROM attempts WHERE id=? AND execution_id=?').get(claim.attemptId, claim.execution.id);
      if (!attempt || this.db.prepare('SELECT id FROM observations WHERE attempt_id=?').get(claim.attemptId)) return;
      // Append-only evidence: late results have no authority to change execution or assessment state.
      this.insertEnvelope(claim.attemptId, envelope);
      this.event(claim.execution.experiment_id, claim.plan.actorId, 'LateResponseRecorded', { attemptId: claim.attemptId });
    });
  }
  recover(projectId, ownerId, leaseMs) {
    return this.transaction(() => {
      this.assertWorker(projectId, ownerId);
      const rows = this.db.prepare(`SELECT e.*,l.expires_ms,p.snapshot,p.plan_hash FROM execution_leases l JOIN executions e ON e.id=l.execution_id
        JOIN experiments p ON p.id=e.experiment_id WHERE p.project_id=? AND l.expires_ms<=?`).all(projectId, this.clock());
      const grading = [];
      for (const row of rows) {
        if (row.state !== 'running') { this.db.prepare('DELETE FROM execution_leases WHERE execution_id=?').run(row.id); continue; }
        const plan = JSON.parse(row.snapshot);
        if (fingerprint(plan) !== row.plan_hash) throw Error('SNAPSHOT_INTEGRITY_ERROR');
        const attempt = this.db.prepare('SELECT * FROM attempts WHERE execution_id=? ORDER BY attempt_no DESC LIMIT 1').get(row.id);
        const saved = this.db.prepare('SELECT id FROM observations WHERE attempt_id=?').get(attempt.id);
        const generation = row.generation + 1;
        this.db.prepare('UPDATE executions SET generation=? WHERE id=?').run(generation, row.id);
        if (saved) {
          this.db.prepare('UPDATE attempts SET generation=? WHERE id=?').run(generation, attempt.id);
          this.db.prepare('UPDATE execution_leases SET owner_id=?,expires_ms=? WHERE execution_id=?').run(ownerId, this.clock() + leaseMs, row.id);
          grading.push({ attemptId: attempt.id, generation, execution: row, plan, ownerId });
          this.event(row.experiment_id, plan.actorId, 'AssessmentRecoveryClaimed', { attemptId: attempt.id, generation, workerId: ownerId });
        } else {
          const state = attempt.state === 'claimed' ? 'queued' : 'outcome_unknown';
          this.db.prepare('UPDATE executions SET state=? WHERE id=?').run(state, row.id);
          this.db.prepare('UPDATE attempts SET state=?,error=? WHERE id=?').run(state === 'queued' ? 'interrupted_before_dispatch' : 'outcome_unknown', 'WORKER_INTERRUPTED', attempt.id);
          this.db.prepare('DELETE FROM execution_leases WHERE execution_id=?').run(row.id);
          this.event(row.experiment_id, plan.actorId, 'ExecutionRecovered', { attemptId: attempt.id, state, workerId: ownerId });
        }
      }
      return grading;
    });
  }
}
