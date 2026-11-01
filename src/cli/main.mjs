import { parseArgs } from 'node:util';
import { openSync, readSync, closeSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { capabilities } from '../application/capabilities.mjs';
import { ExperimentService } from '../application/experiments.mjs';
import { ApplicationError, publicError } from '../application/errors.mjs';

const COMMANDS = {
  capabilities: [],
  'plan validate': ['file', 'project'],
  'experiment create': ['file', 'project', 'idempotency-key', 'db'],
  'experiment get': ['id', 'project', 'db'],
};
const USAGE = [
  'decision-lab capabilities --json',
  'decision-lab plan validate --file PLAN [--project PROJECT] --json',
  'decision-lab experiment create --file PLAN --project PROJECT --idempotency-key KEY [--db PATH] --json',
  'decision-lab experiment get --id ID --project PROJECT [--db PATH] --json',
];
function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, tokens: true, options: {
      json: { type: 'boolean' }, help: { type: 'boolean' },
      ...Object.fromEntries(['file', 'project', 'id', 'idempotency-key', 'db'].map(name => [name, { type: 'string' }])),
    } });
  } catch { throw new ApplicationError('INVALID_ARGUMENTS', 'Unknown or malformed arguments. Use --help.'); }
  const seen = new Set();
  for (const token of parsed.tokens) if (token.kind === 'option') {
    if (seen.has(token.name)) throw new ApplicationError('INVALID_ARGUMENTS', 'Duplicate options are not allowed.');
    seen.add(token.name);
  }
  if (parsed.values.help && !parsed.positionals.length && seen.size === 1) return { command: 'help', values: {} };
  const command = parsed.positionals.join(' '), allowed = COMMANDS[command];
  if (!allowed || [...seen].some(name => name !== 'json' && !allowed.includes(name))) throw new ApplicationError('INVALID_ARGUMENTS', 'Unknown command or option. Use --help.');
  return { command, values: parsed.values };
}
function required(values, name) {
  if (typeof values[name] !== 'string' || !values[name].trim()) throw new ApplicationError('INVALID_ARGUMENTS', `Required option: --${name}.`);
  return values[name];
}
function readPlan(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(8388609);
    let length = 0, bytes;
    while (length < buffer.length && (bytes = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += bytes;
    if (length > 8388608) throw new ApplicationError('PLAN_TOO_LARGE', 'Plan exceeds the 8 MiB limit.');
    try { return JSON.parse(buffer.toString('utf8', 0, length)); }
    catch { throw new ApplicationError('INVALID_JSON', 'Plan file must contain valid JSON.'); }
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('PLAN_UNREADABLE', 'Plan file could not be read.');
  } finally { if (fd !== undefined) closeSync(fd); }
}

export async function runCli(argv, { environment = process.env, stdout = process.stdout } = {}) {
  const result = { schemaVersion: 'decision-lab.result/v1', requestId: randomUUID(), data: null, error: null };
  let exitCode = 0;
  try {
    const { command, values } = parse(argv);
    if (command === 'help') result.data = { kind: 'help', usage: USAGE, output: 'JSON only; diagnostics on stderr.', contractVersion: 'decision-lab.cli/v1' };
    else if (command === 'capabilities') result.data = capabilities();
    else {
      const database = resolve(values.db || '.local/decision-lab.sqlite');
      // Preflight/capability calls never import SQLite, create directories or open a database.
      const service = new ExperimentService({ environment, openStore() { throw new Error('Store not initialized'); } });
      if (command === 'plan validate') result.data = service.validate(readPlan(required(values, 'file')), { projectId: values.project });
      else {
        // Validate arguments and plan before any database side effect.
        const projectId = required(values, 'project');
        let plan, key, id;
        if (command === 'experiment create') {
          plan = readPlan(required(values, 'file'));
          key = required(values, 'idempotency-key');
          if (key.length > 256) throw new ApplicationError('INVALID_IDEMPOTENCY_KEY', 'Idempotency key exceeds 256 characters.');
          service.validate(plan, { projectId });
        } else {
          id = required(values, 'id');
          if (!existsSync(database)) throw new ApplicationError('NOT_FOUND', 'Experiment not found in this project.');
        }
        const { ExperimentStore } = await import('../server/storage/experiment-store.mjs');
        service.openStore = operation => new ExperimentStore(database, { readOnly: operation === 'get' });
        result.data = command === 'experiment create' ? service.create(plan, { projectId, idempotencyKey: key }) : service.get(id, { projectId });
      }
    }
  } catch (error) {
    const safe = publicError(error);
    result.error = { code: safe.code, message: safe.message, details: safe.details, retryable: safe.retryable };
    exitCode = safe.exitCode;
  }
  stdout.write(JSON.stringify(result) + '\n');
  return exitCode;
}
