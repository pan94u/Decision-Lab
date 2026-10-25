import http from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import worker from '../worker/index.js';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT must be between 1 and 65535');
const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
const server = http.createServer(async (req, res) => {
  // Bind only to loopback and reject foreign Host headers (DNS rebinding).
  if (!allowedHosts.has(req.headers.host)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Use the printed localhost URL' }));
    return;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 200000) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: '请求超过 200 KB' }));
        return;
      }
      chunks.push(chunk);
    }
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await worker.fetch(request, process.env, {});
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: '本地服务处理失败，请检查请求格式后重试' }));
  }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用。关闭旧服务或在 .env 中设置其他 PORT。` : `本地服务启动失败：${error.code}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  const configured = !!process.env.CLOUDFLARE_API_TOKEN && /^[a-fA-F0-9]{32}$/.test(process.env.CLOUDFLARE_ACCOUNT_ID || '');
  console.log(`Local: http://localhost:${port}`);
  console.log(`Cloudflare credentials: ${configured ? 'configured (values hidden)' : 'missing — configure .env or use npm run setup'}`);
});
