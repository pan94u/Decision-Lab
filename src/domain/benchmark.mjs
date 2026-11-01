import { createHash } from 'node:crypto';

export const DOMAIN_VERSION = 'benchmark-contract/1';
const forbidden = /^(authorization|api[_-]?key|token|password|secret|cookie)$/i;
function assertJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(assertJson); return; }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      if (forbidden.test(key)) throw Error(`Secret-bearing field is not allowed in evidence: ${key}`);
      assertJson(item);
    }
    return;
  }
  throw Error('Snapshots require finite JSON values');
}
export function canonical(value) {
  assertJson(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
export const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
const requireText = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw Error(`${name} is required`); };

export function validatePlan(plan) {
  assertJson(plan);
  for (const field of ['projectId', 'actorId']) requireText(plan[field], field);
  for (const object of ['suite', 'subject', 'protocol', 'evaluation']) {
    if (!plan[object]) throw Error(`${object} is required`);
    requireText(plan[object].id, `${object}.id`);
    requireText(plan[object].revision, `${object}.revision`);
  }
  if (!['derived', 'custom', 'official-compatible'].includes(plan.protocol.mode)) throw Error('Protocol compatibility mode is required');
  if (plan.protocol.mode === 'official-compatible' && !plan.protocol.verificationReport) throw Error('Official compatibility needs a verification report');
  if (!Array.isArray(plan.suite.cases) || !plan.suite.cases.length) throw Error('Suite must contain cases');
  if (new Set(plan.suite.cases.map(c => c.id)).size !== plan.suite.cases.length) throw Error('Duplicate case ID');
  for (const c of plan.suite.cases) {
    requireText(c.id, 'case.id');
    requireText(c.source?.revision, 'case.source.revision');
    if (!c.input || !c.reference) throw Error('Case requires input and separate reference evidence');
    if (!['choice', 'classification', 'instructions'].includes(c.kind)) throw Error(`Unsupported task kind: ${c.kind}`);
    if (c.kind === 'instructions') {
      if (!Array.isArray(c.input.criteria) || !c.input.criteria.length) throw Error('Instructions require criteria');
    } else {
      if (!Array.isArray(c.input.labels) || c.input.labels.length < 2 || new Set(c.input.labels).size !== c.input.labels.length || c.input.labels.some(x => typeof x !== 'string')) throw Error('Unique label space is required');
      if (!c.input.labels.includes(c.reference.label)) throw Error('Reference label is outside declared label space');
    }
  }
  if (plan.repeats !== undefined && (!Number.isSafeInteger(plan.repeats) || plan.repeats < 1 || plan.repeats > 100)) throw Error('Repeats must be 1–100');
  return plan;
}

// Do not pass Case or Plan to a model adapter: labels/reference evidence stay in the evaluator.
export function adapterInput(c, protocol, subject) {
  return structuredClone({ caseId: c.id, kind: c.kind, input: c.input, protocol, subject });
}

const supported = new Set(['keywords:existence', 'keywords:forbidden_words', 'detectable_format:json_format', 'startend:quotation']);
function checkCriterion(criterion, text) {
  const { id, args = {} } = criterion;
  if (!supported.has(id)) throw Error(`Unsupported IFEval criterion: ${id}`);
  if (!text.trim()) return false;
  if (id === 'keywords:existence') return args.keywords.every(word => new RegExp(word, 'i').test(text));
  if (id === 'keywords:forbidden_words') return args.forbidden_words.every(word => !new RegExp('\\b' + word + '\\b', 'i').test(text));
  if (id === 'startend:quotation') { const t = text.trim(); return t.length > 1 && t.startsWith('"') && t.endsWith('"'); }
  let t = text.trim();
  for (const prefix of ['```json', '```Json', '```JSON', '```']) if (t.startsWith(prefix)) t = t.slice(prefix.length);
  if (t.endsWith('```')) t = t.slice(0, -3);
  try { JSON.parse(t.trim()); return true; } catch { return false; }
}
function looseCandidates(text) {
  const lines = text.split('\n');
  const variants = [text, lines.slice(1).join('\n').trim(), lines.slice(0, -1).join('\n').trim(), lines.slice(1, -1).join('\n').trim()];
  return [...variants, ...variants.map(t => t.replaceAll('*', ''))];
}

export function assess(c, raw, evaluation) {
  requireText(evaluation.id, 'evaluation.id');
  requireText(evaluation.revision, 'evaluation.revision');
  if (c.kind === 'instructions') {
    if (typeof raw?.text !== 'string') return invalid(c, 'Missing generated text');
    if (!['strict', 'loose'].includes(evaluation.variant)) throw Error('IFEval variant must be strict or loose');
    const texts = evaluation.variant === 'loose' ? looseCandidates(raw.text) : [raw.text];
    const units = c.input.criteria.map((criterion, i) => ({ id: `${c.id}:${i}:${criterion.id}`, type: 'criterion', valid: true, correct: texts.some(text => checkCriterion(criterion, text)) }));
    return { status: 'valid', caseId: c.id, casePass: units.every(u => u.correct), units };
  }
  const labels = c.input.labels;
  let selected = raw?.selected, probabilities = raw?.probabilities ?? null;
  if (raw?.logScores) {
    if (labels.some(k => !Number.isFinite(raw.logScores[k]))) return invalid(c, 'Missing/non-finite candidate log score');
    const max = Math.max(...labels.map(k => raw.logScores[k]));
    const weights = labels.map(k => Math.exp(raw.logScores[k] - max)), sum = weights.reduce((a, b) => a + b, 0);
    probabilities = Object.fromEntries(labels.map((k, i) => [k, weights[i] / sum]));
    selected = labels.reduce((best, k) => raw.logScores[k] > raw.logScores[best] ? k : best, labels[0]);
  }
  if (!labels.includes(selected)) return invalid(c, 'Selection is outside declared label space');
  if (probabilities !== null) {
    if (Object.keys(probabilities).length !== labels.length || labels.some(k => typeof probabilities[k] !== 'number' || !Number.isFinite(probabilities[k]) || probabilities[k] < 0 || probabilities[k] > 1)) return invalid(c, 'Invalid distribution');
    const sum = labels.reduce((n, k) => n + probabilities[k], 0);
    if (Math.abs(sum - 1) > 0.002) return invalid(c, 'Probabilities do not sum to one');
    probabilities = Object.fromEntries(labels.map(k => [k, probabilities[k] / sum]));
  }
  const correct = selected === c.reference.label;
  return { status: 'valid', caseId: c.id, casePass: correct, units: [{ id: c.id, type: 'case', valid: true, correct, predicted: selected, expected: c.reference.label, probabilities }] };
}
function invalid(c, reason) { return { status: 'invalid', caseId: c.id, casePass: false, reason, units: [{ id: c.id, type: 'case', valid: false, correct: null }] }; }

export function aggregate(assessments) {
  const units = assessments.flatMap(a => a.units), valid = units.filter(x => x.valid), categorical = valid.filter(x => x.expected !== undefined);
  const labels = [...new Set(categorical.flatMap(x => [x.expected, x.predicted]))];
  const f1 = labels.length ? labels.reduce((sum, label) => {
    const tp = categorical.filter(x => x.expected === label && x.predicted === label).length;
    const fp = categorical.filter(x => x.expected !== label && x.predicted === label).length;
    const fn = categorical.filter(x => x.expected === label && x.predicted !== label).length;
    return sum + (2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : 0);
  }, 0) / labels.length : null;
  return { cases: assessments.length, units: units.length, validUnits: valid.length, invalidCases: assessments.filter(a => a.status !== 'valid').length,
    casePassRate: assessments.length ? assessments.filter(a => a.casePass).length / assessments.length : null,
    unitAccuracy: valid.length ? valid.filter(x => x.correct).length / valid.length : null, macroF1ObservedLabels: f1,
    confusion: categorical.map(x => ({ expected: x.expected, predicted: x.predicted })) };
}
