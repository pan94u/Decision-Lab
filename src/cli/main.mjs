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
  'experiment cancel': ['id', 'project', 'actor', 'db'],
  'worker run': ['project', 'db', 'once', 'allow-live', 'lease-ms', 'poll-ms'],
};
const USAGE = [
  'decision-lab capabilities --json',
  'decision-lab plan validate --file PLAN [--project PROJECT] --json',
  'decision-lab experiment create --file PLAN --project PROJECT --idempotency-key KEY [--db PATH] --json',
  'decision-lab experiment get --id ID --project PROJECT [--db PATH] --json',
  'decision-lab experiment cancel --id ID --project PROJECT --actor ACTOR [--db PATH] --json',
  'decision-lab worker run --project PROJECT [--db PATH] [--once] [--allow-live] [--lease-ms 30000] [--poll-ms 250]',
];
function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, tokens: true, options: {
      json: { type: 'boolean' }, help: { type: 'boolean' }, once: { type: 'boolean' }, 'allow-live': { type: 'boolean' },
      ...Object.fromEntries(['file', 'project', 'id', 'idempotency-key', 'db', 'actor', 'lease-ms', 'poll-ms'].map(name => [name, { type: 'string' }])),
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

export async function runCli(argv, { environment = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const result = { schemaVersion: 'decision-lab.result/v1', requestId: randomUUID(), data: null, error: null };
  let exitCode = 0, workerMode = false;
  try {
    const { command, values } = parse(argv);
    workerMode = command === 'worker run';
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
        } else if (!workerMode) {
          id = required(values, 'id');
          if (command === 'experiment cancel') required(values, 'actor');
          if (!existsSync(database)) throw new ApplicationError('NOT_FOUND', 'Experiment not found in this project.');
        }
        let leaseMs = 30000, pollMs = 250;
        if (workerMode) {
          const positive = (name, fallback, min, max) => {
            const value = values[name] === undefined ? fallback : Number(values[name]);
            if (!Number.isSafeInteger(value) || value < min || value > max) throw new ApplicationError('INVALID_ARGUMENTS', `Invalid --${name} range.`);
            return value;
          };
          leaseMs = positive('lease-ms', 30000, 1000, 300000);
          pollMs = positive('poll-ms', 250, 10, 10000);
        }
        const { RuntimeStore } = await import('../server/storage/runtime-store.mjs');
        service.openStore = operation => new RuntimeStore(database, { readOnly: operation === 'get' });
        if (workerMode) {
          const { runWorker } = await import('../server/worker/runner.mjs');
          const store = service.openStore('worker'), shutdown = new AbortController();
          const stop = () => shutdown.abort();
          process.once('SIGINT', stop); process.once('SIGTERM', stop);
          try {
            await runWorker({ store, projectId, environment, allowLive: !!values['allow-live'], once: !!values.once,
              leaseMs, pollMs, signal: shutdown.signal, diagnostic: data => stderr.write(JSON.stringify(data) + '\n') });
          } finally {
            process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); store.close();
          }
          return 0;
        }
        result.data = command === 'experiment create' ? service.create(plan, { projectId, idempotencyKey: key })
          : command === 'experiment cancel' ? service.cancel(id, { projectId, actorId: values.actor }) : service.get(id, { projectId });
      }
    }
  } catch (error) {
    const safe = publicError(error);
    result.error = { code: safe.code, message: safe.message, details: safe.details, retryable: safe.retryable };
    exitCode = safe.exitCode;
    if (workerMode) { stderr.write(JSON.stringify({ type: 'WorkerError', ...result.error }) + '\n'); return exitCode; }
  }
  stdout.write(JSON.stringify(result) + '\n');
  return exitCode;
}
