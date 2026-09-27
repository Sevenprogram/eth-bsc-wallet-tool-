import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { createGateway } from '../deploy/gateway.mjs';

const root = new URL('..', import.meta.url);
const cli = (...args) => spawnSync(process.execPath, ['deploy/setup.mjs', ...args], { cwd: root, encoding: 'utf8' });
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function stop(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('deployment TLS gateway authenticates every path, forwards safely, and diagnoses failed backend', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chainfolio-deploy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cert = path.join(directory, 'tls.crt'), key = path.join(directory, 'tls.key');
  const ssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
    '-subj', '/CN=203.0.113.10', '-addext', 'subjectAltName=IP:203.0.113.10', '-keyout', key, '-out', cert], { encoding: 'utf8' });
  assert.equal(ssl.status, 0, ssl.stderr);
  const certificate = await readFile(cert);
  const calls = [];
  const backend = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ headers: req.headers, url: req.url, body });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ csrf: 'test-csrf', ok: true }));
  });
  const backendPort = await listen(backend); t.after(() => stop(backend));
  const login = { username: 'admin', password: randomBytes(24).toString('base64url') };
  const authorization = 'Basic ' + Buffer.from(`${login.username}:${login.password}`).toString('base64');
  const config = { origin: 'https://203.0.113.10:8443', backendPort, cert, key,
    authorizationHash: createHash('sha256').update(authorization).digest('hex') };
  const gateway = createGateway(config);
  const port = await listen(gateway); t.after(() => stop(gateway));
  const request = (headers = {}, body, method = 'GET', target = '/api/state') => new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port, method, path: target, agent: false,
      ca: certificate, checkServerIdentity: (_host, peer) => checkServerIdentity('203.0.113.10', peer),
      headers: { Host: '203.0.113.10:8443', ...headers },
    }, res => {
      let body = ''; res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }); req.on('error', reject); req.end(body);
  });
  for (const target of ['/', '/api/state', '/api/wallets', '/style.css']) {
    const r = await request({}, undefined, 'GET', target); assert.equal(r.status, 401); assert.ok(r.headers['www-authenticate']);
  }
  assert.equal((await request({ Authorization: 'Basic invalid' })).status, 401);
  assert.equal(calls.length, 0);
  const headers = { Authorization: authorization, Origin: config.origin, 'Content-Type': 'application/json',
    'X-Chainfolio-Token': 'csrf-token', 'X-Forwarded-Host': 'attacker.example' };
  assert.equal((await request(headers, '{"test":true}', 'POST', '/api/import')).status, 200);
  assert.equal(calls.at(-1).body, '{"test":true}');
  assert.equal(calls.at(-1).headers.host, '203.0.113.10:8443');
  assert.equal(calls.at(-1).headers['x-chainfolio-token'], 'csrf-token');
  assert.equal(calls.at(-1).headers.authorization, undefined);
  assert.equal(calls.at(-1).headers['x-forwarded-host'], undefined);
  assert.equal((await request({ ...headers, Origin: 'http://203.0.113.10:8443' })).status, 403);
  assert.equal((await request({ ...headers, Host: 'evil.example' })).status, 403);
  assert.equal((await request(headers, undefined, 'DELETE')).status, 405);
  assert.equal((await request({ ...headers, 'Content-Length': String(61 * 1024 * 1024) }, '', 'POST')).status, 413);
  assert.equal((await request(headers, undefined, 'GET', '//evil.example')).status, 400);

  // Verify the generated health-check client validates the certificate's IP, not 127.0.0.1.
  config.origin = `https://203.0.113.10:${port}`;
  await stop(gateway);
  const actualGateway = createGateway(config);
  await new Promise(resolve => actualGateway.listen(port, '127.0.0.1', resolve));
  t.after(() => stop(actualGateway));
  await writeFile(path.join(directory, 'gateway.json'), JSON.stringify(config));
  await writeFile(path.join(directory, 'login.json'), JSON.stringify(login));
  const child = spawn(process.execPath, ['deploy/setup.mjs', 'check', directory], { cwd: root, stdio: 'pipe' });
  let error = ''; child.stderr.on('data', chunk => error += chunk);
  const [code] = await once(child, 'exit'); assert.equal(code, 0, error);
  await stop(backend);
  assert.equal((await request({ Authorization: authorization, Host: `203.0.113.10:${port}` })).status, 502);
});

test('installer config preserves RPC credentials and login across updates; occupied ports are rejected', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chainfolio-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = path.join(directory, 'first'), second = path.join(directory, 'second');
  await mkdir(first); await mkdir(second);
  const env = path.join(directory, '.env');
  await writeFile(env, 'ETH_RPC_URL=https://eth.example/secret\nBSC_RPC_URL=https://bsc.example/secret\nPORT=99\n');
  let r = cli('config', first, path.join(directory, 'missing'), '203.0.113.10', '8443', '18088', '/var/lib/chainfolio-server', env);
  assert.equal(r.status, 0, r.stderr);
  const login = JSON.parse(await readFile(path.join(first, 'login.json')));
  assert.equal(login.password.length, 32);
  const output = await readFile(path.join(first, 'app.env'), 'utf8');
  assert.match(output, /PORT=18088/); assert.match(output, /https:\/\/eth.example\/secret/);
  assert.ok(!(await readFile(path.join(first, 'gateway.json'), 'utf8')).includes(login.password));
  await writeFile(env, 'ETH_RPC_URL=https://replacement.example\n');
  r = cli('config', second, first, '203.0.113.10', '8444', '18089', '/var/lib/chainfolio-server', env);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(await readFile(path.join(second, 'login.json'))), login);
  assert.match(await readFile(path.join(second, 'app.env'), 'utf8'), /https:\/\/eth.example\/secret/);
  assert.notEqual(cli('validate-ip', '0.0.0.0').status, 0);
  assert.notEqual(cli('validate-ip', '999.1.1.1').status, 0);
  assert.equal(cli('validate-ip', '203.0.113.10').status, 0);
  assert.notEqual(cli('port', '1', '2').status, 0);
  assert.notEqual(cli('stop-source', directory, directory, '0').status, 0);
  await writeFile(env, `DATA_DIR="${first}"\n`);
  assert.equal(cli('data-directory', directory, env).stdout.trim(), first);
  const occupied = http.createServer(); const port = await listen(occupied); t.after(() => stop(occupied));
  assert.notEqual(cli('port', String(port), String(port)).status, 0);
});

test('Linux migration stops only a verified source wallet process', { skip: process.platform !== 'linux' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chainfolio-old-process-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = path.join(directory, 'data'), other = path.join(directory, 'other');
  await mkdir(data); await mkdir(other);
  const script = 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);console.log("ready");';
  await writeFile(path.join(directory, 'server.mjs'), script);
  await writeFile(path.join(other, 'server.mjs'), script);
  const old = spawn(process.execPath, ['server.mjs'], { cwd: directory, env: { ...process.env, DATA_DIR: data }, stdio: 'pipe' });
  t.after(() => { if (old.exitCode === null) old.kill('SIGTERM'); });
  await once(old.stdout, 'data');
  const call = async source => {
    const child = spawn(process.execPath, ['deploy/setup.mjs', 'stop-source', source, data, String(old.pid)], { cwd: root, stdio: 'pipe' });
    let error = ''; child.stderr.on('data', chunk => error += chunk);
    const [status] = await once(child, 'exit'); return { status, error };
  };
  assert.notEqual((await call(other)).status, 0);
  assert.equal(old.exitCode, null);
  const result = await call(directory); assert.equal(result.status, 0, result.error);
});
