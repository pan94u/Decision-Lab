import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { ExperimentService } from '../src/application/experiments.mjs';

const cli = fileURLToPath(new URL('../bin/decision-lab.mjs', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL('../examples/plans/local-fixture.json', import.meta.url)));
const unsupported = JSON.parse(readFileSync(new URL('../examples/plans/unsupported-clef-generation.json', import.meta.url)));
const checkResult = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync(new URL('../contracts/result.v1.schema.json', import.meta.url))));
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function workspace(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'decision-lab-cli-'));
  try { return fn(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function invoke(directory, args, expected = 0, env = {}) {
  const proc = spawnSync(process.execPath, [cli, ...args], {
    cwd: directory, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', NODE_OPTIONS: '', ...env },
  });
  assert.equal(proc.error, undefined);
  assert.equal(proc.status, expected, proc.stdout + proc.stderr);
  assert.equal(proc.stdout.trim().split('\n').length, 1, 'stdout is one JSON result');
  const result = JSON.parse(proc.stdout);
  assert.ok(checkResult(result), JSON.stringify(checkResult.errors));
  return { ...result, stdout: proc.stdout, stderr: proc.stderr };
}
function save(directory, plan = fixture) {
  const path = join(directory, 'plan.json'); writeFileSync(path, JSON.stringify(plan)); return path;
}
const createArgs = (file, key = 'session-test') => ['experiment', 'create', '--file', file, '--project', 'local-demo', '--idempotency-key', key, '--json'];

test('CLI discovers implemented capabilities, versions and help without opening SQLite', () => workspace(directory => {
  const result = invoke(directory, ['capabilities', '--json']);
  assert.equal(result.data.execution.available, false);
  assert.deepEqual(result.data.commands, ['capabilities', 'plan validate', 'experiment create', 'experiment get']);
  assert.equal(result.stderr, '');
  assert.equal(invoke(directory, ['--help']).data.kind, 'help');
  assert.equal(existsSync(join(directory, '.local')), false);
}));

test('CLI preflight is offline and side-effect free, rejects unsupported tasks and insufficient budgets', () => workspace(directory => {
  const file = save(directory);
  const result = invoke(directory, ['plan', 'validate', '--file', file, '--json']);
  assert.equal(result.data.valid, true); assert.equal(result.data.invocationUpperBound, 1);
  assert.equal(result.data.estimatedCost, null); assert.equal(result.stderr, '');
  writeFileSync(join(directory, '.env'), 'CLOUDFLARE_API_TOKEN=this-file-must-not-be-read');
  save(directory, unsupported);
  const invalid = invoke(directory, createArgs(file), 2);
  assert.equal(invalid.error.code, 'PLAN_INCOMPATIBLE');
  assert.ok(invalid.error.details.some(x => x.code === 'UNSUPPORTED_TASK'));
  const budget = structuredClone(fixture); budget.repeats = 2; save(directory, budget);
  assert.ok(invoke(directory, createArgs(file), 2).error.details.some(x => x.code === 'INSUFFICIENT_CALL_BUDGET'));
  assert.equal(existsSync(join(directory, '.local')), false);
}));

test('separate CLI processes create, replay and read one frozen experiment in explicit project scope', () => workspace(directory => {
  const file = save(directory), created = invoke(directory, createArgs(file)).data;
  assert.equal(created.state, 'queued'); assert.equal(created.executionCounts.planned, 1);
  assert.equal(created.validation.warnings[0].code, 'WORKER_UNAVAILABLE');
  const replay = invoke(directory, createArgs(file)).data;
  assert.equal(replay.experimentId, created.experimentId);
  const db = join(directory, '.local/decision-lab.sqlite'), before = digest(db);
  const changed = structuredClone(fixture); changed.suite.cases[0].reference.label = 'account_balance'; save(directory, changed);
  assert.equal(invoke(directory, createArgs(file), 2).error.code, 'IDEMPOTENCY_CONFLICT');
  const args = ['experiment', 'get', '--id', created.experimentId, '--project', 'local-demo', '--json'];
  const result = invoke(directory, args).data;
  assert.equal(result.planHash, created.planHash); assert.deepEqual(result.executions, created.executions);
  assert.equal(result.snapshot, undefined); assert.equal(result.reference, undefined);
  assert.equal(digest(db), before, 'read operation must not migrate or modify the database');
  args[5] = 'other-project';
  assert.equal(invoke(directory, args, 2).error.code, 'NOT_FOUND');
}));

test('CLI schema and domain errors never echo plan contents or malformed argument values', () => workspace(directory => {
  const marker = 'must-never-appear-in-output';
  const file = save(directory, { ...fixture, apiKey: marker });
  let result = invoke(directory, createArgs(file), 2);
  assert.equal(result.error.code, 'INVALID_PLAN'); assert.ok(!result.stdout.includes(marker));
  save(directory, { ...fixture, protocol: { ...fixture.protocol, token: marker } });
  result = invoke(directory, createArgs(file), 2);
  assert.equal(result.error.code, 'INVALID_PLAN'); assert.ok(!result.stdout.includes(marker));
  writeFileSync(file, '{"token":"' + marker);
  result = invoke(directory, ['plan', 'validate', '--file', file], 2);
  assert.equal(result.error.code, 'INVALID_JSON'); assert.ok(!result.stdout.includes(marker));
  result = invoke(directory, ['capabilities', '--bad-' + marker], 2);
  assert.equal(result.error.code, 'INVALID_ARGUMENTS'); assert.ok(!result.stdout.includes(marker));
  assert.equal(invoke(directory, ['capabilities', '--json', '--json'], 2).error.code, 'INVALID_ARGUMENTS');
  assert.equal(invoke(directory, ['experiment', 'get', '--id', 'missing', '--project', 'local-demo'], 2).error.code, 'NOT_FOUND');
  save(directory);
  assert.equal(invoke(directory, [...createArgs(file), '--db', join(file, 'invalid.sqlite')], 1).error.code, 'INTERNAL_ERROR');
  writeFileSync(file, Buffer.alloc(8388609, 32));
  assert.equal(invoke(directory, ['plan', 'validate', '--file', file], 2).error.code, 'PLAN_TOO_LARGE');
  assert.equal(existsSync(join(directory, '.local')), false);
}));

test('machine plans require explicit versions, valid evaluator inputs and truthful protocol compatibility', () => workspace(directory => {
  const variants = [];
  let plan = structuredClone(fixture); plan.schemaVersion = 'unknown/v2'; variants.push([plan, 'INVALID_PLAN']);
  plan = structuredClone(fixture); plan.suite.cases.push(structuredClone(plan.suite.cases[0])); variants.push([plan, 'INVALID_PLAN']);
  plan = structuredClone(fixture); plan.suite.cases[0].input.text = ' '; variants.push([plan, 'PLAN_INCOMPATIBLE']);
  plan = structuredClone(fixture); plan.evaluation = {id:'ifeval',revision:'1',variant:'strict'}; variants.push([plan, 'PLAN_INCOMPATIBLE']);
  plan = structuredClone(fixture); plan.protocol = {...plan.protocol,mode:'official-compatible',verificationReport:'unverified-claim'}; variants.push([plan, 'PLAN_INCOMPATIBLE']);
  plan = structuredClone(unsupported); plan.subject = fixture.subject; plan.suite.cases[0].input.criteria = [{id:'keywords:existence',args:{}}]; variants.push([plan,'PLAN_INCOMPATIBLE']);
  for (const [value, code] of variants) {
    const file = save(directory, value);
    assert.equal(invoke(directory, ['plan','validate','--file',file], 2).error.code, code);
  }
  const file = save(directory);
  assert.equal(invoke(directory, ['plan','validate','--file',file,'--project','other'], 2).error.code, 'PROJECT_MISMATCH');
  assert.equal(existsSync(join(directory, '.local')), false);
}));

test('credential references resolve only in process environment, without credential output or persistence', () => workspace(directory => {
  const plan = structuredClone(fixture);
  plan.subject = {id:'clef',revision:'1',adapter:'cloudflare-native',model:'clef',credentialRef:'env:TEST_MODEL_CREDENTIAL'};
  const file = save(directory, plan), args = ['plan','validate','--file',file,'--json'];
  writeFileSync(join(directory, '.env'), 'TEST_MODEL_CREDENTIAL=not-auto-loaded\nCLOUDFLARE_ACCOUNT_ID=' + '0'.repeat(32));
  assert.equal(invoke(directory, args, 2).error.code, 'CREDENTIAL_UNAVAILABLE');
  const key = 'test-credential-that-must-stay-private', env = {TEST_MODEL_CREDENTIAL:key,CLOUDFLARE_ACCOUNT_ID:'0'.repeat(32)};
  let result = invoke(directory, args, 0, env);
  assert.equal(result.data.valid, true); assert.ok(!result.stdout.includes(key));
  const db = join(directory, 'live-plan.sqlite');
  result = invoke(directory, [...createArgs(file), '--db', db], 0, env);
  assert.equal(result.data.state, 'queued');
  assert.ok(!result.stdout.includes(key));
  assert.ok(!readFileSync(db).includes(Buffer.from(key)), 'referenced credential is not persisted');
  plan.suite.cases[0].input.text += key; save(directory, plan);
  result = invoke(directory, createArgs(file), 2, env);
  assert.equal(result.error.code, 'CREDENTIAL_IN_PLAN'); assert.ok(!result.stdout.includes(key));
  assert.equal(existsSync(join(directory, '.local')), false);
}));

test('application service can be reused by UI and preflight never opens a repository or calls fetch', () => {
  let opens = 0;
  const service = new ExperimentService({openStore(){ opens++; throw Error('do-not-expose-configured-key'); }});
  const previous = globalThis.fetch;
  globalThis.fetch = () => { throw Error('network must not be used'); };
  try {
    assert.equal(service.validate(fixture).valid, true); assert.equal(opens, 0);
    assert.throws(() => service.create(fixture, {projectId:'wrong-project',idempotencyKey:'key'}), e => e.code === 'PROJECT_MISMATCH');
    assert.equal(opens, 0);
    assert.throws(() => service.create(fixture, {projectId:fixture.projectId,idempotencyKey:'key'}), e => e.code === 'INTERNAL_ERROR' && !e.message.includes('configured-key'));
    assert.equal(opens, 1);
  } finally { globalThis.fetch = previous; }
});
