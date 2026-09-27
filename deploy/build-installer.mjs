import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'dist', 'chainfolio-install.sh');
const temp = mkdtempSync(path.join(os.tmpdir(), 'chainfolio-package-'));
const files = ['package.json', 'package-lock.json', 'server.mjs', 'README.md', 'DEPLOYMENT.md', '.env.example'];
for (const directory of ['lib', 'public']) {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(mjs|js|css|html)$/.test(entry.name)) throw Error(`Unexpected package entry: ${directory}/${entry.name}`);
    files.push(`${directory}/${entry.name}`);
  }
}
files.push('deploy/install-ubuntu.sh', 'deploy/setup.mjs', 'deploy/gateway.mjs', 'deploy/ONE-CLICK.md',
  'deploy/1panel-v1.md', 'deploy/chainfolio.service', 'deploy/.env.example');
try {
  const result = spawnSync('tar', ['-czf', path.join(temp, 'payload.tar.gz'), ...files], {
    cwd: root, encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (result.status !== 0) throw Error(result.stderr || 'tar failed');
  const payload = readFileSync(path.join(temp, 'payload.tar.gz'));
  const hash = createHash('sha256').update(payload).digest('hex');
  const loader = `#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
if [[ "\$*" == "--help" || "\$*" == "-h" ]]; then
  echo '运行：sudo bash chainfolio-install.sh --ip 45.144.136.146 [--port 8443]'
  echo '可选：--stop-old 核对后正常停止旧钱包；--cert 正式证书 --key 私钥；--import-data 旧数据目录'
  echo '自动安装独立 HTTPS 服务，不修改 1Panel；默认生成自签证书和随机登录密码。'
  exit 0
fi
[[ \$(uname -s) == Linux ]] || { echo '请在 Ubuntu/Debian 服务器上运行。' >&2; exit 1; }
[[ \$EUID == 0 ]] || { echo '请用 sudo bash 运行。' >&2; exit 1; }
work=\$(mktemp -d /tmp/chainfolio-unpack.XXXXXXXX)
trap 'rm -rf -- "\$work"' EXIT
payload_line=\$(awk '/^__CHAINFOLIO_PAYLOAD__$/ {print NR+1; exit}' "\$0")
tail -n +"\$payload_line" "\$0" | base64 -d >"\$work/payload.tar.gz"
echo '${hash}  '"\$work/payload.tar.gz" | sha256sum -c - >/dev/null
tar -xzf "\$work/payload.tar.gz" -C "\$work"
export CHAINFOLIO_ORIGINAL_CWD="\$PWD"
bash "\$work/deploy/install-ubuntu.sh" "\$@"
exit 0
__CHAINFOLIO_PAYLOAD__
`;
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, loader + payload.toString('base64').match(/.{1,76}/g).join('\n') + '\n', { mode: 0o755 });
  console.log(`Created ${output} (${payload.length} compressed bytes; source only, no wallets or credentials)`);
} finally { rmSync(temp, { recursive: true, force: true }); }
