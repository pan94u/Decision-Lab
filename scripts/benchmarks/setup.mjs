import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};
run('python3', ['-m', 'venv', '.cache/benchmarks/venv']);
run('.cache/benchmarks/venv/bin/python', ['-m', 'pip', 'install', '-r', 'benchmarks/requirements.txt']);
console.log('Benchmark-only Python environment prepared. No API key is needed.');
