import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Separate TLS/login entry point; the wallet process remains loopback-only.
export function createGateway(config) {
  const endpoint = new URL(config.origin);
  const expected = Buffer.from(config.authorizationHash, 'hex');
  if (endpoint.protocol !== 'https:' || expected.length !== 32 ||
      !Number.isInteger(config.backendPort) || config.backendPort < 1024 || config.backendPort > 65535) {
    throw Error('Invalid gateway configuration');
  }
  const reply = (res, status, message, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(message);
  };
  const server = https.createServer({
    cert: readFileSync(config.cert), key: readFileSync(config.key), minVersion: 'TLSv1.2',
    maxHeaderSize: 16384, requestTimeout: 180000, headersTimeout: 15000,
  }, (req, res) => {
    if (req.headers.host !== endpoint.host) return reply(res, 403, '不允许的主机');
    const digest = createHash('sha256').update(String(req.headers.authorization || '')).digest();
    // Installer-generated credentials have 192 bits of entropy; no user-chosen weak passwords.
    if (!timingSafeEqual(digest, expected)) {
      return reply(res, 401, '请使用安装脚本生成的网站账号密码登录', {
        'WWW-Authenticate': 'Basic realm="Chainfolio", charset="UTF-8"',
      });
    }
    if (req.headers.origin && req.headers.origin !== endpoint.origin) return reply(res, 403, '不允许的来源');
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return reply(res, 400, '无效路径');
    if (!['GET', 'POST'].includes(req.method)) return reply(res, 405, '不支持的方法');
    const length = Number(req.headers['content-length'] || 0);
    if (!Number.isSafeInteger(length) || length < 0 || length > 60 * 1024 * 1024) return reply(res, 413, '请求过大');
    // Forward only the headers used by the app, never login credentials or client proxy headers.
    const headers = { host: endpoint.host };
    for (const name of ['content-type', 'content-length', 'origin', 'x-chainfolio-token', 'accept']) {
      if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: config.backendPort,
      path: req.url, method: req.method, headers, timeout: 180000,
    }, response => {
      res.writeHead(response.statusCode, { ...response.headers, 'Cache-Control': 'no-store' });
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(Error('timeout')));
    upstream.on('error', () => {
      if (!res.headersSent) reply(res, 502, '钱包后台暂不可用，请检查 systemctl status chainfolio-server');
      else res.destroy();
    });
    let received = 0;
    req.on('data', chunk => {
      received += chunk.length;
      if (received > 60 * 1024 * 1024) {
        if (!res.headersSent) reply(res, 413, '请求过大');
        upstream.destroy();
        req.unpipe(upstream);
      }
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });
  server.maxConnections = 256;
  server.on('upgrade', (_req, socket) => socket.destroy());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const server = createGateway(config);
  server.on('error', error => { console.error(`入口启动失败: ${error.code || error.message}`); process.exit(1); });
  server.listen(Number(new URL(config.origin).port || 443), '0.0.0.0', () => console.log(`Chainfolio HTTPS: ${config.origin}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 20000).unref();
  });
}
