import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { fingerprint, validatePlan } from '../domain/benchmark.mjs';
import { ADAPTERS } from './capabilities.mjs';
import { ApplicationError } from './errors.mjs';

export const PLAN_SCHEMA = JSON.parse(readFileSync(new URL('../../contracts/plan.v1.schema.json', import.meta.url), 'utf8'));
const checkSchema = new Ajv2020({ allErrors: true }).compile(PLAN_SCHEMA);
const issue = (code, path) => ({ code, path });

// Shared by CLI and future UI/API application entry points. Never reads the network or writes storage.
export function preflightPlan(input, { projectId, environment = {} } = {}) {
  // Detach from caller-owned mutable objects before validating and freezing the fingerprint.
  let plan;
  try { plan = structuredClone(input); } catch { throw new ApplicationError('INVALID_PLAN', 'Plan must be JSON data.'); }
  if (!checkSchema(plan)) throw new ApplicationError('INVALID_PLAN', 'Plan does not match decision-lab.plan/v1.', {
    details: checkSchema.errors.map(e => ({ path: e.instancePath, rule: e.keyword })),
  });
  try { validatePlan(plan); } catch {
    throw new ApplicationError('INVALID_PLAN', 'Plan violates domain constraints (identities, reference labels, source versions or evidence safety).');
  }
  if (projectId !== undefined && projectId !== plan.projectId) throw new ApplicationError('PROJECT_MISMATCH', 'Explicit project context differs from the plan.');
  const adapter = ADAPTERS[plan.subject.adapter], issues = [];
  if (plan.protocol.mode === 'official-compatible') issues.push(issue('UNVERIFIED_OFFICIAL_PROTOCOL', '/protocol/mode'));
  for (const [index, c] of plan.suite.cases.entries()) {
    const path = `/suite/cases/${index}`;
    if (!adapter.taskKinds.includes(c.kind)) issues.push(issue('UNSUPPORTED_TASK', path + '/kind'));
    if (c.kind === 'classification' && !c.input.text?.trim()) issues.push(issue('MISSING_UTTERANCE', path + '/input/text'));
    if (c.kind === 'choice') {
      if (!c.input.prompt?.trim()) issues.push(issue('MISSING_PROMPT', path + '/input/prompt'));
      const candidates = c.input.candidates;
      if (!candidates || candidates.length !== c.input.labels.length || new Set(candidates.map(x => x.id)).size !== candidates.length || c.input.labels.some(label => !candidates.some(x => x.id === label))) {
        issues.push(issue('CANDIDATE_LABEL_MISMATCH', path + '/input/candidates'));
      }
    }
    if (c.kind === 'instructions') {
      if (!c.input.prompt?.trim()) issues.push(issue('MISSING_PROMPT', path + '/input/prompt'));
      for (const [i, criterion] of c.input.criteria.entries()) {
        const args = criterion.id === 'keywords:existence' ? criterion.args.keywords : criterion.id === 'keywords:forbidden_words' ? criterion.args.forbidden_words : [];
        if (!args) issues.push(issue('MISSING_CRITERION_ARGUMENT', `${path}/input/criteria/${i}/args`));
        else for (const word of args) {
          try { new RegExp(word, 'i'); } catch { issues.push(issue('INVALID_CRITERION_PATTERN', `${path}/input/criteria/${i}/args`)); }
        }
      }
      if (plan.evaluation.id !== 'ifeval' || !plan.evaluation.variant) issues.push(issue('EVALUATOR_MISMATCH', '/evaluation'));
    } else if (plan.evaluation.id !== 'label-match' || plan.evaluation.variant) issues.push(issue('EVALUATOR_MISMATCH', '/evaluation'));
  }
  const executions = plan.suite.cases.length * plan.repeats;
  if (plan.budget.maxInvocations < executions) issues.push(issue('INSUFFICIENT_CALL_BUDGET', '/budget/maxInvocations'));
  if (plan.subject.adapter === 'cloudflare-native' && !plan.subject.model) issues.push(issue('MISSING_MODEL', '/subject/model'));
  if (plan.subject.adapter === 'controlled-fixture' && (plan.subject.model || plan.subject.credentialRef)) issues.push(issue('FIXTURE_CONFIGURATION_MISMATCH', '/subject'));
  if (issues.length) throw new ApplicationError('PLAN_INCOMPATIBLE', 'Task, evaluation, adapter or budget requirements do not match.', { details: issues });
  if (plan.subject.adapter === 'cloudflare-native') {
    const name = plan.subject.credentialRef?.slice(4);
    if (!name || typeof environment[name] !== 'string' || !environment[name].trim() || !/^[a-f0-9]{32}$/i.test(environment.CLOUDFLARE_ACCOUNT_ID || '')) {
      throw new ApplicationError('CREDENTIAL_UNAVAILABLE', 'Configure the referenced credential and Cloudflare account in the execution environment.');
    }
    // Prevent known configured credentials from being frozen if pasted into any plan string.
    if (JSON.stringify(plan).includes(environment[name])) throw new ApplicationError('CREDENTIAL_IN_PLAN', 'Plan contains a configured credential value; use credentialRef only.');
  }
  return { plan, validation: {
    kind: 'plan-validation', valid: true, planHash: fingerprint(plan),
    plannedExecutions: executions, invocationUpperBound: executions,
    budget: plan.budget, estimatedCost: null,
    warnings: [{ code: 'WORKER_UNAVAILABLE', message: 'Plan can be queued; this release has no independent Worker.' },
      ...(plan.subject.adapter === 'controlled-fixture' ? [{ code: 'CONTROLLED_TEST_ONLY', message: 'Fixture outputs cannot be reported as model capability scores.' }] : [])],
  } };
}
