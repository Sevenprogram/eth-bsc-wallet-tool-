import { readFileSync, writeFileSync, existsSync, readlinkSync, realpathSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { isIP, createServer } from 'node:net';
import { parseEnv } from 'node:util';
import https from 'node:https';
import { checkServerIdentity, rootCertificates } from 'node:tls';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
if (command === 'port') {
  const [start, end] = args.map(Number);
  if (![start, end].every(value => Number.isInteger(value) && value >= 1024 && value <= 65535) || start > end) throw Error('无效端口范围');
  for (let port = start; port <= end; port++) {
    let available = true;
    for (const host of ['127.0.0.1', '0.0.0.0']) {
      available = await new Promise(resolve => {
        const server = createServer();
        server.once('error', () => resolve(false));
        server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
      });
      if (!available) break;
    }
    if (available) { console.log(port); process.exit(0); }
  }
  throw Error('指定范围内没有空闲端口');
} else if (command === 'validate-ip') {
  if (isIP(args[0]) !== 4 || args[0] === '0.0.0.0' || args[0].startsWith('127.')) throw Error('请传入服务器公网 IPv4 地址');
} else if (command === 'data-directory') {
  const [cwd, envFile] = args;
  const input = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const data = path.resolve(cwd, input.DATA_DIR || 'data');
  if (existsSync(data)) console.log(data);
} else if (command === 'stop-source') {
  const [source, data, rawPid] = args;
  if (!/^[1-9][0-9]*$/.test(rawPid)) throw Error('无效的旧钱包 PID');
  const pid = Number(rawPid), proc = `/proc/${pid}`;
  const cwd = realpathSync(readlinkSync(`${proc}/cwd`));
  const argv = readFileSync(`${proc}/cmdline`, 'utf8').split('\0').filter(Boolean);
  const executable = path.basename(readlinkSync(`${proc}/exe`));
  const expectedScript = realpathSync(path.join(source, 'server.mjs'));
  const env = Object.fromEntries(readFileSync(`${proc}/environ`, 'utf8').split('\0').filter(Boolean).map(value => {
    const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)];
  }));
  const dotenv = existsSync(path.join(cwd, '.env')) ? parseEnv(readFileSync(path.join(cwd, '.env'), 'utf8')) : {};
  const actualData = realpathSync(path.resolve(cwd, env.DATA_DIR || dotenv.DATA_DIR || 'data'));
  const scriptMatches = argv.slice(1).some(arg => !arg.startsWith('-') && path.resolve(cwd, arg) === expectedScript);
  if (!/^node(js)?$/.test(executable) || cwd !== realpathSync(source) || !scriptMatches || actualData !== realpathSync(data)) {
    throw Error('无法证明占用者是这个项目的旧钱包进程，未停止它');
  }
  console.log(`已核对项目路径与数据目录，正在正常停止旧钱包进程 ${pid}`);
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 150; i++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') process.exit(0); throw error; }
  }
  throw Error('旧钱包 30 秒内没有退出，未强行杀死或复制其数据');
} else if (command === 'config') {
  const [directory, previous, ip, publicPort, backendPort, data, sourceEnv] = args;
  const readJson = file => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const credentials = readJson(path.join(previous, 'login.json')) || { username: 'admin', password: randomBytes(24).toString('base64url') };
  const origin = `https://${ip}:${publicPort}`;
  const authorization = 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
  const config = { origin, backendPort: Number(backendPort),
    authorizationHash: createHash('sha256').update(authorization).digest('hex'),
    cert: path.join(directory, 'tls.crt'), key: path.join(directory, 'tls.key') };
  writeFileSync(path.join(directory, 'gateway.json'), JSON.stringify(config, null, 2), { mode: 0o640 });
  writeFileSync(path.join(directory, 'login.json'), JSON.stringify(credentials, null, 2), { mode: 0o600 });
  const previousEnv = path.join(previous, 'app.env');
  const input = existsSync(previousEnv) ? parseEnv(readFileSync(previousEnv, 'utf8')) : existsSync(sourceEnv) ? parseEnv(readFileSync(sourceEnv, 'utf8')) : {};
  const lines = [`PORT=${backendPort}`, `DATA_DIR=${data}`, `PUBLIC_ORIGIN=${origin}`];
  for (const name of ['ETH_RPC_URL', 'BSC_RPC_URL']) {
    const value = input[name] || (name === 'ETH_RPC_URL' ? 'https://ethereum-rpc.publicnode.com' : 'https://bsc-dataseed.bnbchain.org');
    if (/[\r\n\0]/.test(value)) throw Error(`${name} 包含无效换行符`);
    lines.push(`${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  }
  writeFileSync(path.join(directory, 'app.env'), lines.join('\n') + '\n', { mode: 0o640 });
} else if (command === 'check') {
  const [directory] = args;
  const config = JSON.parse(readFileSync(path.join(directory, 'gateway.json'), 'utf8'));
  const credentials = JSON.parse(readFileSync(path.join(directory, 'login.json'), 'utf8'));
  const endpoint = new URL(config.origin);
  // Trust only this installation's certificate, connect over loopback, and verify its IP identity.
  const request = authenticated => new Promise((resolve, reject) => {
    const headers = { Host: endpoint.host };
    if (authenticated) headers.Authorization = 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
    const req = https.get({ hostname: '127.0.0.1', port: endpoint.port, path: '/api/state', agent: false,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(endpoint.hostname, certificate),
      ca: [...rootCertificates, readFileSync(config.cert)], headers, timeout: 5000,
    }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(Error('健康检查超时'))); req.on('error', reject);
  });
  if ((await request(false)).status !== 401) throw Error('未登录请求没有被拦截');
  const response = await request(true);
  if (response.status !== 200 || !JSON.parse(response.body).csrf) throw Error('登录后的钱包 API 检查失败');
  console.log('HTTPS、网站登录和钱包 API 检查通过');
} else if (command === 'show') {
  const config = JSON.parse(readFileSync(path.join(args[0], 'gateway.json'), 'utf8'));
  const login = JSON.parse(readFileSync(path.join(args[0], 'login.json'), 'utf8'));
  console.log(`访问地址：${config.origin}\n账号：${login.username}\n密码：${login.password}`);
} else throw Error('未知安装命令');
