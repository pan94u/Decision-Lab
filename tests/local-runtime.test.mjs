import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';

test('local server handles both loopback URLs and rejects foreign origins/hosts', async () => {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32), CLOUDFLARE_API_TOKEN: 'test-placeholder' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('server startup timeout')), 10000);
      child.stdout.on('data', buffer => { if (String(buffer).includes('Local:')) { clearTimeout(timer); resolve(); } });
      child.on('exit', code => { clearTimeout(timer); reject(Error(`server exited ${code}`)); });
    });
    for (const host of ['localhost', '127.0.0.1']) {
      const base = `http://${host}:${port}`;
      const health = await (await fetch(base + '/api/health')).json();
      assert.equal(health.cloudflareConfigured, true);
      const response = await fetch(base + '/api/infer', { method: 'POST', headers: { origin: base }, body: '{}' });
      assert.equal(response.status, 400); // Validation error, not a false cross-origin rejection.
    }
    const foreignHostStatus = await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/api/health', headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(`http://localhost:${port}/api/infer`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })).status, 403);
  } finally { child.kill('SIGTERM'); await once(child, 'exit'); }
});
