#!/usr/bin/env bash
# Dedicated installation; never rewrites 1Panel/OpenResty configuration.
set -Eeuo pipefail
umask 077
BASE=/opt/chainfolio-server
CONFIG=/etc/chainfolio-server
DATA=/var/lib/chainfolio-server
SERVICE_USER=chainfolio-svc
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
ORIGINAL_CWD=${CHAINFOLIO_ORIGINAL_CWD:-$PWD}
PUBLIC_IP= PUBLIC_PORT= CERT= KEY= IMPORT_DATA=
STOP_OLD=0
usage() {
  cat <<'HELP'
用法：sudo bash chainfolio-install.sh --ip 45.144.136.146
选项：
  --port 8443          指定公网 HTTPS 端口；不指定则自动选择空闲端口
  --cert /path/cert    正式证书 fullchain 文件，与 --key 配合使用
  --key /path/key      正式证书私钥文件
  --import-data /dir   首次安装时复制旧数据；旧钱包必须已停止
  --stop-old           迁移前正常停止经路径和数据目录验证的旧钱包进程
  --help              显示帮助
默认自动选择公网 8443 起的空闲端口；不修改 1Panel，不停止其他进程。
HELP
}
die() { echo "错误：$*" >&2; return 1; }
while (($#)); do
  case "$1" in
    --ip|--port|--cert|--key|--import-data)
      (($# >= 2)) || die "$1 缺少参数"
      case "$1" in
        --ip) PUBLIC_IP=$2;; --port) PUBLIC_PORT=$2;; --cert) CERT=$2;;
        --key) KEY=$2;; --import-data) IMPORT_DATA=$2;;
      esac; shift 2;;
    --stop-old) STOP_OLD=1; shift;;
    --help|-h) usage; exit 0;;
    *) die "未知参数：$1";;
  esac
done
[[ $(uname -s) == Linux && -f /etc/os-release ]] || die '此脚本用于 Ubuntu/Debian Linux 服务器'
[[ $EUID == 0 ]] || die '请使用 sudo bash 运行此脚本'
[[ -d /run/systemd/system ]] || die '需要运行 systemd 的主机，请在服务器终端执行，不要在普通容器内执行'
[[ -n $PUBLIC_IP ]] || die '请指定 --ip 服务器公网IPv4'
[[ $PUBLIC_IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die '无效的 IPv4 地址'
if [[ -n $PUBLIC_PORT ]]; then
  [[ $PUBLIC_PORT =~ ^[1-9][0-9]{3,4}$ ]] || die '端口必须为 1024–65535'
  ((PUBLIC_PORT >= 1024 && PUBLIC_PORT <= 65535)) || die '端口必须为 1024–65535'
fi
[[ -z $CERT && -z $KEY || -n $CERT && -n $KEY ]] || die '--cert 和 --key 必须同时提供'
[[ -z $CERT || -r $CERT && -r $KEY ]] || die '无法读取证书或私钥文件'
[[ -f $SOURCE/server.mjs && -f $SOURCE/package-lock.json ]] || die '安装包不完整'
command -v apt-get >/dev/null || die '此脚本需要 Ubuntu/Debian 的 apt-get'
if ! command -v curl >/dev/null || ! command -v openssl >/dev/null || ! command -v flock >/dev/null || ! command -v xz >/dev/null || ! command -v ss >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl openssl util-linux xz-utils iproute2
fi
exec 9>/run/lock/chainfolio-install.lock
flock -n 9 || die '已有安装进程运行，请等待它完成'
[[ ! -e $BASE || -f $BASE/.managed ]] || die "$BASE 已存在且不属于本脚本，未覆盖"
if [[ ! -f $BASE/.managed ]]; then
  [[ ! -e $CONFIG && ! -e $DATA ]] || die '目标配置或数据目录已存在，请先确认归属；未覆盖'
  for name in chainfolio-server chainfolio-web; do
    [[ ! -e /etc/systemd/system/$name.service ]] || die "$name.service 已存在，未覆盖"
  done
fi
TMP=$(mktemp -d /tmp/chainfolio-install.XXXXXXXX)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)-$$
SWITCHED=0 STOPPED=0 ADDED_FIREWALL=0
OLD_RELEASE=$(readlink "$BASE/current" 2>/dev/null || true)
OLD_CONFIG=$(readlink "$CONFIG/current" 2>/dev/null || true)
OLD_CONFIG=${OLD_CONFIG:-$TMP/no-previous}
OLD_APP_ACTIVE=0 OLD_WEB_ACTIVE=0
systemctl is-active --quiet chainfolio-server && OLD_APP_ACTIVE=1
systemctl is-active --quiet chainfolio-web && OLD_WEB_ACTIVE=1
cleanup() { rm -rf -- "$TMP"; }
trap cleanup EXIT
failure() {
  local code=$1 line=$2
  trap - ERR
  set +e
  echo "安装未完成（步骤行 $line，退出码 $code），正在恢复原有服务。" >&2
  if ((SWITCHED)); then
    systemctl stop chainfolio-web chainfolio-server
    if [[ -n $OLD_RELEASE && -n $OLD_CONFIG ]]; then
      ln -sfn "$OLD_RELEASE" "$BASE/current.rollback"
      mv -Tf "$BASE/current.rollback" "$BASE/current"
      ln -sfn "$OLD_CONFIG" "$CONFIG/current.rollback"
      mv -Tf "$CONFIG/current.rollback" "$CONFIG/current"
      if [[ -d $BASE/backups/$STAMP/data ]]; then
        mv "$DATA" "$BASE/backups/$STAMP/failed-data"
        cp -a "$BASE/backups/$STAMP/data" "$DATA"
      fi
    else
      systemctl disable chainfolio-web chainfolio-server >/dev/null 2>&1
      rm -f /etc/systemd/system/chainfolio-web.service /etc/systemd/system/chainfolio-server.service
      rm -f "$BASE/current" "$CONFIG/current"
    fi
  fi
  for name in chainfolio-server chainfolio-web; do
    [[ ! -f $TMP/$name.service ]] || cp "$TMP/$name.service" "/etc/systemd/system/$name.service"
  done
  systemctl daemon-reload
  if ((STOPPED)); then
    ((OLD_APP_ACTIVE == 0)) || systemctl start chainfolio-server
    ((OLD_WEB_ACTIVE == 0)) || systemctl start chainfolio-web
  fi
  if ((ADDED_FIREWALL)); then ufw --force delete allow "$PUBLIC_PORT/tcp" >/dev/null; fi
  echo '未停止或修改 OpenResty。安装文件和数据备份保留，原数据未删除。' >&2
  echo '诊断命令：journalctl -u chainfolio-server -u chainfolio-web -n 50 --no-pager' >&2
  exit "$code"
}
trap 'failure "$?" "$LINENO"' ERR

echo '[1/7] 检查 Node.js 和运行环境'
NODE=$(command -v node || true)
if [[ -n $NODE ]] && "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13))process.exit(1);require("node:sqlite")' >/dev/null 2>&1 && command -v npm >/dev/null; then
  NODE=$(readlink -f "$NODE")
else
  case $(uname -m) in x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; *) die '自动安装 Node 仅支持 x64/arm64';; esac
  curl -fsSL --proto '=https' --tlsv1.2 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$TMP/SHASUMS256.txt"
  ARCHIVE=$(awk -v arch="$ARCH" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$TMP/SHASUMS256.txt")
  [[ -n $ARCHIVE && $ARCHIVE != *$'\n'* ]] || die '无法从 Node 官方校验清单找到安装包'
  curl -fsSL --proto '=https' --tlsv1.2 "https://nodejs.org/dist/latest-v24.x/$ARCHIVE" -o "$TMP/$ARCHIVE"
  (cd "$TMP" && awk -v file="$ARCHIVE" '$2 == file' SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$TMP/$ARCHIVE" -C "$TMP"
  NODE="$TMP/${ARCHIVE%.tar.xz}/bin/node"
  export PATH="$(dirname "$NODE"):$PATH"
fi
"$NODE" "$SOURCE/deploy/setup.mjs" validate-ip "$PUBLIC_IP"

echo '[2/7] 检查旧钱包数据并准备应用'
if [[ -z $IMPORT_DATA && ! -d $DATA/keystores && ! -f $DATA/wallets.sqlite ]]; then
  if [[ -f $ORIGINAL_CWD/server.mjs ]]; then IMPORT_DATA=$("$NODE" "$SOURCE/deploy/setup.mjs" data-directory "$ORIGINAL_CWD" "$ORIGINAL_CWD/.env")
  elif [[ -d /var/lib/chainfolio ]]; then IMPORT_DATA=/var/lib/chainfolio; fi
fi
if [[ -n $IMPORT_DATA ]]; then
  [[ -d $IMPORT_DATA && ! -L $IMPORT_DATA ]] || die '旧数据目录不存在或为符号链接'
  IMPORT_DATA=$(cd "$IMPORT_DATA" && pwd -P)
  [[ $IMPORT_DATA != "$DATA" ]] || die '无需将受管数据目录导入自身'
  [[ ! -f $DATA/wallets.sqlite && ! -d $DATA/keystores ]] || die '已有受管钱包数据，不自动覆盖或合并；请使用网页备份恢复'
  if [[ -f $IMPORT_DATA/service.lock ]]; then
    PID=$(cat "$IMPORT_DATA/service.lock")
    if [[ $PID =~ ^[1-9][0-9]*$ ]] && kill -0 "$PID" 2>/dev/null; then
      if ((STOP_OLD)); then
        "$NODE" "$SOURCE/deploy/setup.mjs" stop-source "$ORIGINAL_CWD" "$IMPORT_DATA" "$PID"
        if [[ -f $IMPORT_DATA/service.lock ]]; then
          PID=$(cat "$IMPORT_DATA/service.lock")
          if [[ $PID =~ ^[1-9][0-9]*$ ]] && kill -0 "$PID" 2>/dev/null; then die '旧钱包被其他守护程序重新启动，请先停止旧服务'; fi
        fi
      else
        die "旧钱包进程 $PID 仍在运行。可加 --stop-old 自动核对并正常停止它，或在原终端按 Ctrl+C 后重试。"
      fi
    fi
  fi
  echo "将复制旧数据：$IMPORT_DATA（保留原目录）"
fi
install -d -m 755 "$BASE" "$BASE/releases"
touch "$BASE/.managed"
install -d -m 700 "$BASE/backups" "$CONFIG" "$CONFIG/versions"
RELEASE="$BASE/releases/$STAMP"
VERSION_CONFIG="$CONFIG/versions/$STAMP"
install -d -m 755 "$RELEASE" "$RELEASE/runtime"
install -d -m 700 "$VERSION_CONFIG"
cp "$SOURCE/package.json" "$SOURCE/package-lock.json" "$SOURCE/server.mjs" "$RELEASE/"
cp -R "$SOURCE/lib" "$SOURCE/public" "$SOURCE/deploy" "$RELEASE/"
install -m 755 "$NODE" "$RELEASE/runtime/node"
(cd "$RELEASE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
chmod -R a+rX "$RELEASE"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$DATA" --shell /usr/sbin/nologin "$SERVICE_USER"
getent group "$SERVICE_USER" >/dev/null || die "缺少服务用户组 $SERVICE_USER"
chown root:"$SERVICE_USER" "$CONFIG" "$CONFIG/versions" "$VERSION_CONFIG"
chmod 750 "$CONFIG" "$CONFIG/versions" "$VERSION_CONFIG"

echo '[3/7] 保存旧部署并选择空闲端口'
for name in chainfolio-server chainfolio-web; do
  [[ ! -f /etc/systemd/system/$name.service ]] || cp "/etc/systemd/system/$name.service" "$TMP/"
done
STOPPED=1
if [[ -n $OLD_RELEASE ]]; then systemctl stop chainfolio-web chainfolio-server; fi
if [[ -d $DATA ]]; then
  install -d -m 700 "$BASE/backups/$STAMP"
  cp -a --reflink=auto "$DATA" "$BASE/backups/$STAMP/data"
fi
if [[ -n $IMPORT_DATA ]]; then
  [[ ! -e $DATA ]] || rmdir "$DATA"
  cp -a --reflink=auto "$IMPORT_DATA" "$DATA"
  rm -f "$DATA/service.lock"
fi
install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA"
chmod -R go-rwx "$DATA"
if [[ -z $PUBLIC_PORT && -f $OLD_CONFIG/gateway.json ]]; then
  PREVIOUS_PORT=$("$NODE" -e 'const fs=require("fs");console.log(new URL(JSON.parse(fs.readFileSync(process.argv[1])).origin).port)' "$OLD_CONFIG/gateway.json")
  if "$NODE" "$SOURCE/deploy/setup.mjs" port "$PREVIOUS_PORT" "$PREVIOUS_PORT" >/dev/null 2>&1; then PUBLIC_PORT=$PREVIOUS_PORT; fi
fi
if [[ -n $PUBLIC_PORT ]]; then
  "$NODE" "$SOURCE/deploy/setup.mjs" port "$PUBLIC_PORT" "$PUBLIC_PORT" >/dev/null || { echo "公网端口 $PUBLIC_PORT 已占用，未停止占用进程；去掉 --port 可让脚本选择空闲端口。" >&2; false; }
else PUBLIC_PORT=$("$NODE" "$SOURCE/deploy/setup.mjs" port 8443 8543); fi
BACKEND_PORT=$("$NODE" "$SOURCE/deploy/setup.mjs" port 18088 18188)
if [[ $BACKEND_PORT == "$PUBLIC_PORT" ]]; then BACKEND_PORT=$("$NODE" "$SOURCE/deploy/setup.mjs" port 18189 18289); fi
echo "公网 HTTPS：$PUBLIC_PORT；钱包内部：$BACKEND_PORT（不需要在 1Panel 添加它们）"

echo '[4/7] 生成 HTTPS 证书和网站登录配置'
if [[ -n $CERT ]]; then
  install -m 640 "$CERT" "$VERSION_CONFIG/tls.crt"
  install -m 640 "$KEY" "$VERSION_CONFIG/tls.key"
elif [[ -f $OLD_CONFIG/tls.crt ]] && openssl x509 -in "$OLD_CONFIG/tls.crt" -noout -checkip "$PUBLIC_IP" >/dev/null 2>&1 && openssl x509 -in "$OLD_CONFIG/tls.crt" -noout -checkend 2592000 >/dev/null; then
  cp "$OLD_CONFIG/tls.crt" "$OLD_CONFIG/tls.key" "$VERSION_CONFIG/"
  [[ ! -f $OLD_CONFIG/self-signed ]] || touch "$VERSION_CONFIG/self-signed"
else
  # Do not silently replace an existing externally managed certificate.
  if [[ -f $OLD_CONFIG/tls.crt && ! -f $OLD_CONFIG/self-signed ]]; then
    echo '现有正式证书需要更新，请通过 --cert 和 --key 传入新证书。' >&2; false
  fi
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
    -subj "/CN=$PUBLIC_IP" -addext "subjectAltName=IP:$PUBLIC_IP" \
    -keyout "$VERSION_CONFIG/tls.key" -out "$VERSION_CONFIG/tls.crt" 2>"$TMP/openssl.log"
  touch "$VERSION_CONFIG/self-signed"
fi
openssl x509 -in "$VERSION_CONFIG/tls.crt" -noout -checkip "$PUBLIC_IP" >/dev/null
openssl x509 -in "$VERSION_CONFIG/tls.crt" -noout -checkend 0 >/dev/null
ENV_SOURCE="$ORIGINAL_CWD/.env"
[[ -f $ENV_SOURCE || ! -f /etc/chainfolio.env ]] || ENV_SOURCE=/etc/chainfolio.env
"$NODE" "$SOURCE/deploy/setup.mjs" config "$VERSION_CONFIG" "${OLD_CONFIG:-$TMP/no-previous}" "$PUBLIC_IP" "$PUBLIC_PORT" "$BACKEND_PORT" "$DATA" "$ENV_SOURCE"
chown root:"$SERVICE_USER" "$VERSION_CONFIG/"*
chmod 640 "$VERSION_CONFIG/"*
chmod 600 "$VERSION_CONFIG/login.json"

echo '[5/7] 安装后台服务（开机启动）'
cat >"$TMP/chainfolio-server.new" <<'UNIT'
[Unit]
Description=Chainfolio wallet backend (managed installer)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=chainfolio-svc
Group=chainfolio-svc
WorkingDirectory=/opt/chainfolio-server/current
EnvironmentFile=/etc/chainfolio-server/current/app.env
ExecStart=/opt/chainfolio-server/current/runtime/node /opt/chainfolio-server/current/server.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/chainfolio-server
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
[Install]
WantedBy=multi-user.target
UNIT
cat >"$TMP/chainfolio-web.new" <<'UNIT'
[Unit]
Description=Chainfolio HTTPS and login (managed installer)
After=chainfolio-server.service
Wants=chainfolio-server.service
[Service]
Type=simple
User=chainfolio-svc
Group=chainfolio-svc
WorkingDirectory=/opt/chainfolio-server/current
ExecStart=/opt/chainfolio-server/current/runtime/node /opt/chainfolio-server/current/deploy/gateway.mjs /etc/chainfolio-server/current/gateway.json
Restart=on-failure
RestartSec=5
TimeoutStopSec=25
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
[Install]
WantedBy=multi-user.target
UNIT
SWITCHED=1
ln -sfn "$RELEASE" "$BASE/current.next"
mv -Tf "$BASE/current.next" "$BASE/current"
ln -sfn "$VERSION_CONFIG" "$CONFIG/current.next"
mv -Tf "$CONFIG/current.next" "$CONFIG/current"
install -m 644 "$TMP/chainfolio-server.new" /etc/systemd/system/chainfolio-server.service
install -m 644 "$TMP/chainfolio-web.new" /etc/systemd/system/chainfolio-web.service
systemd-analyze verify /etc/systemd/system/chainfolio-server.service /etc/systemd/system/chainfolio-web.service
systemctl daemon-reload
systemctl start chainfolio-server chainfolio-web

echo '[6/7] 检查 HTTPS、登录拦截和钱包 API'
HEALTHY=0
for attempt in {1..20}; do
  if "$RELEASE/runtime/node" "$RELEASE/deploy/setup.mjs" check "$VERSION_CONFIG" >"$TMP/health.log" 2>&1; then HEALTHY=1; break; fi
  sleep 1
done
if ((HEALTHY == 0)); then cat "$TMP/health.log" >&2; false; fi
cat "$TMP/health.log"
systemctl enable chainfolio-server chainfolio-web >/dev/null

echo '[7/7] 配置主机防火墙并输出访问方式'
if command -v ufw >/dev/null && LC_ALL=C ufw status | grep -q '^Status: active'; then
  if ! ufw status | grep -qE "^${PUBLIC_PORT}/tcp[[:space:]]+ALLOW"; then
    ufw allow "$PUBLIC_PORT/tcp" comment 'Chainfolio managed HTTPS'
    ADDED_FIREWALL=1
  fi
fi
trap - ERR
"$RELEASE/runtime/node" "$RELEASE/deploy/setup.mjs" show "$VERSION_CONFIG"
if [[ -f $VERSION_CONFIG/self-signed ]]; then
  echo '证书：自签名。首次访问会提示不受信任，请核对以下 SHA256 指纹后信任，或换成正式证书。'
  openssl x509 -in "$VERSION_CONFIG/tls.crt" -noout -fingerprint -sha256
fi
echo "请在云厂商安全组/其他防火墙放行 TCP $PUBLIC_PORT；本机健康检查不代表公网防火墙已放行。"
echo '不要再在 1Panel 新增域名、修改反向代理或绑定上述端口。关闭 SSH 不会停止服务。'
echo '登录信息仅 root 可查看：sudo cat /etc/chainfolio-server/current/login.json'
echo '运行状态：sudo systemctl status chainfolio-server chainfolio-web --no-pager'
echo '日志：sudo journalctl -u chainfolio-server -u chainfolio-web -n 50 --no-pager'
echo '重启：sudo systemctl restart chainfolio-server chainfolio-web'
echo '服务重启后，自动生成钱包需要在网页重新输入原钱包加密密码。'
