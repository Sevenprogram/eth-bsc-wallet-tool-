# Ubuntu 一键部署：独立 IP + 端口入口

上传 `dist/chainfolio-install.sh` 到服务器，在原项目目录运行（也可以直接运行仓库内的 `deploy/install-ubuntu.sh`）：

```bash
sudo bash chainfolio-install.sh --ip 45.144.136.146 --stop-old
```

单文件安装包内已包含程序，不需要先上传 GitHub 或逐个上传源文件。安装仍需联网获取 Node（如本机版本不足）和 npm 依赖。

脚本默认从 8443 起选择空闲的公网 HTTPS 端口，自动选择另一个仅监听回环地址的后端端口。**以脚本最终打印的 URL 为准，不需要在 1Panel 新增域名或反向代理。** 已有 OpenResty、面板、其他站点保持原状，不强行抢端口。`--stop-old` 只允许正常停止经核对的同项目旧钱包进程，不会停止端口上其他程序。指定端口可以加 `--port 8443`，如果被占用则明确失败。

安装会生成 `admin` 账号及 192 位随机密码，所有网页/API 请求均需登录。打印的访问地址类似 `https://45.144.136.146:8443`。需要完整输入 `https://`；此端口不提供明文 HTTP。密码仅保存在 root 可读取的 `/etc/chainfolio-server/current/login.json`，入口服务读取的是哈希。重复安装保留账号密码。

默认自签 HTTPS 证书，首次访问浏览器会提示不受信任。请先将浏览器证书详情中的 SHA256 指纹与脚本打印的指纹核对，再信任或导入证书；此模式适用于自己使用，不会自动获得浏览器公共信任。已有正式 IP 证书可以传入：

```bash
sudo bash chainfolio-install.sh --ip 45.144.136.146 \
  --cert /path/to/fullchain.pem --key /path/to/privkey.pem
```

正式证书需包含该 IP，续期后再次运行脚本传入更新后的证书。脚本不代替 CA 的申请/续期服务，自签证书有效期一年；重复安装会在剩余有效期不足 30 天时重新生成，此时需重新核对指纹。

## 数据和后台运行

- 程序：`/opt/chainfolio-server/current`，历史版本保留在 `releases/`。
- 数据：`/var/lib/chainfolio-server`，与代码独立，钱包密码不写入配置。
- 配置：`/etc/chainfolio-server/current`，包含 RPC、入口和证书配置。
- 服务：`chainfolio-server`（后台）、`chainfolio-web`（HTTPS/登录）。安装后开机启动，异常退出重启，关闭 SSH 不影响运行。
- 钱包持续生成任务需要网页输入密码后启动；重启后仍需重新输入原钱包密码，不会自动从磁盘恢复密码。
- RPC 首次优先读取原项目 `.env`（或旧 `/etc/chainfolio.env`），否则使用两个公共主网节点。网页保存的 RPC 设置优先，需要额度时在网页更换服务商节点。

首次安装时自动检测原项目目录里的 `data/`（或 `.env` 中的 `DATA_DIR`），或旧的 `/var/lib/chainfolio`。旧服务必须先停止。使用 `--stop-old` 时，脚本核对 `/proc` 中的 Node 可执行文件、启动脚本、工作目录与数据目录后发送 SIGTERM，最多等 30 秒，不强杀进程；不能证明归属时拒绝停止。未提供该选项时会提示先停止旧服务，避免复制运行中的 SQLite。原数据目录保留，不会删除。也可明确指定：

```bash
sudo bash chainfolio-install.sh --ip 45.144.136.146 --import-data /原项目/data
```

已存在受管数据时拒绝自动覆盖/合并，合并应使用网页加密备份恢复。重复安装会先停止本脚本管理的服务，再保存数据备份到 `/opt/chainfolio-server/backups/`，切换代码并执行检查；失败时恢复旧版本及备份。备份消耗磁盘，确认新版本正常并另有备份后再自行清理历史备份；脚本不会自动删除钱包备份。

旧的手动 `npm start` 进程被正常停止后不会在安装失败时自动重新创建，原项目和数据会保留，可回到原项目执行 `npm start`。自动回退针对脚本管理的 systemd 服务。迁移或重启都会清除内存中的钱包密码，需要网页重新输入。

## 防火墙与检查范围

脚本会检查空闲端口、证书、未认证请求应为 401、认证后的钱包 API 应为 200。此检查从服务器回环地址访问 HTTPS 入口，**不能证明公网安全组已放行**。

如果 UFW 已启用，脚本会添加所选公网 TCP 端口的放行规则，不启用/重置 UFW。云厂商安全组、1Panel 自定义防火墙、其他防火墙仍可能需要你放行脚本最后显示的端口。后端端口不开放公网。

常用命令：

```bash
sudo systemctl status chainfolio-server chainfolio-web --no-pager
sudo journalctl -u chainfolio-server -u chainfolio-web -n 50 --no-pager
sudo systemctl restart chainfolio-server chainfolio-web
sudo systemctl stop chainfolio-web chainfolio-server
sudo cat /etc/chainfolio-server/current/login.json
```

更新：上传新安装脚本后运行相同命令。若使用正式证书，保留 `--cert` 和 `--key` 参数。更改 IP 时自签证书会重建；正式证书需要匹配新 IP。已有数据不通过 GitHub 传输。

## 开发者构建

```bash
node deploy/build-installer.mjs
```

构建采用明确的文件清单，仅包含代码及依赖锁文件，排除 `.env`、钱包、数据库、私钥、截图、Git 历史和 `node_modules`。内嵌压缩包附带 SHA256 完整性校验；该校验检测损坏，不替代发布者身份验证。
