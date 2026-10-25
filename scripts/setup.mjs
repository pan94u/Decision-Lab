import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { writeFile, chmod } from 'node:fs/promises';

const rl = createInterface({ input: stdin, output: stdout });
const account = (await rl.question('Cloudflare Account ID: ')).trim();
if (!/^[a-fA-F0-9]{32}$/.test(account)) { rl.close(); throw Error('Account ID 必须是 32 位十六进制字符'); }
rl.close();
if (!stdin.isTTY) throw Error('请在交互式终端运行 npm run setup，Token 输入不会回显');
stdout.write('Cloudflare API Token (hidden): ');
stdin.setRawMode(true);
stdin.resume();
const token = await new Promise((resolve, reject) => {
  let value = '';
  const onData = buffer => {
    for (const char of buffer.toString()) {
      if (char === '\u0003') { cleanup(); reject(Error('配置已取消')); return; }
      if (char === '\r' || char === '\n') { cleanup(); resolve(value.trim()); return; }
      if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
      else if (char >= ' ') value += char;
    }
  };
  const cleanup = () => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); };
  stdin.on('data', onData);
});
if (!token || !/^[A-Za-z0-9_.-]+$/.test(token)) throw Error('Token 为空或包含无效字符');
const path = new URL('../.env', import.meta.url);
await writeFile(path, `CLOUDFLARE_ACCOUNT_ID=${account}\nCLOUDFLARE_API_TOKEN=${token}\nPORT=4173\n`, { mode: 0o600 });
await chmod(path, 0o600);
console.log('已保存 .env（仅当前用户可读写，Git 已忽略）。运行 npm run dev 启动。');
