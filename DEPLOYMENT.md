# GitHub 与 Linux 服务器部署

如需一条命令部署并直接使用 IP + 端口，优先使用 [独立入口一键安装方案](deploy/ONE-CLICK.md)，不需要手动配置 1Panel。下文保留手动 systemd + SSH 隧道的部署方式。

适用于使用 systemd 的 Ubuntu / Debian 服务器。GitHub 保存代码，Node.js 服务在服务器上运行；网页关闭、电脑关机不影响服务器中的任务。当前应用没有远程登录功能，因此通过 SSH 隧道访问，不开放网页端口到公网。

## 1. 上传到 GitHub

在本机项目目录执行。当前目录已经初始化 Git，但还没有提交或远程仓库。先在 GitHub 创建一个 **Private 私有空仓库**，不要初始化 README、License 或 .gitignore。

```sh
cd /Users/sev/program/1/eth-bsc-wallet-tool
git add .gitignore .env.example README.md DEPLOYMENT.md package.json package-lock.json server.mjs lib public test deploy
git diff --cached --stat
git diff --cached --name-only
```

检查待提交文件只有源码、测试、示例配置和文档，再执行：

```sh
git commit -m "Add Chainfolio wallet dashboard and deployment setup"
git branch -M main
# 将下面的 YOUR_NAME 替换为自己的 GitHub 用户名。
git remote add origin git@github.com:YOUR_NAME/eth-bsc-wallet-tool.git
git push -u origin main
```

仓库名不同时相应替换 URL。已有 origin 时先用 `git remote -v` 查看，不要重复添加。如果 GitHub SSH 尚未配置，也可以使用 GitHub 提供的 HTTPS 仓库地址，按凭据管理器提示登录。

已安装并登录 GitHub CLI 的用户，可省略网页创建仓库和上述 remote/push 步骤，在本地提交完成后执行：

```sh
gh repo create eth-bsc-wallet-tool --private --source=. --remote=origin --push
```

两种方式选一种。命令参考：[GitHub CLI 官方说明](https://cli.github.com/manual/gh_repo_create)。

`.gitignore` 排除了 `data/`、真实 `.env`、数据库、备份和本地截图。**钱包私钥、加密 keystore、备份文件、RPC API Key 都不应上传仓库，即使仓库是私有的。** 忽略规则不影响已被 Git 跟踪的文件，所以仍需检查待提交清单。示例配置不填写私人凭据。

## 2. 在服务器安装代码

准备 Git 和系统级 Node.js 24 LTS（程序最低要求 Node.js 22.13）。安装方式见 [Node.js 官方下载页](https://nodejs.org/en/download)，版本状态见 [官方发布列表](https://nodejs.org/en/about/previous-releases)。不要直接假设系统自带的 Node 版本满足要求。

登录服务器后检查：

```sh
node --version
npm --version
command -v node
git --version
```

以下命令以具备 sudo 权限的部署用户执行。私有仓库需要先为该用户配置 GitHub 读取权限，例如仅有读取权限的仓库 Deploy Key；凭据不写在仓库 URL 中。

```sh
# /opt/chainfolio 应为新目录；已有部署时使用本文的更新步骤。
sudo install -d -m 755 -o "$(id -un)" -g "$(id -gn)" /opt/chainfolio
git clone git@github.com:YOUR_NAME/eth-bsc-wallet-tool.git /opt/chainfolio
cd /opt/chainfolio
npm ci --omit=dev
# 只调整代码目录权限，运行数据会存放在另一个目录。
chmod -R a+rX /opt/chainfolio
```

## 3. 配置后台服务与开机启动

首次部署创建专用服务用户（已有该用户时跳过 useradd）：

```sh
sudo useradd --system --user-group --home-dir /var/lib/chainfolio --shell /usr/sbin/nologin chainfolio
cd /opt/chainfolio
sudo install -m 600 deploy/.env.example /etc/chainfolio.env
sudo install -m 644 deploy/chainfolio.service /etc/systemd/system/chainfolio.service
```

检查 `command -v node` 的结果。服务文件默认 `/usr/bin/node`；如果系统级安装路径为 `/usr/local/bin/node`，用 `sudoedit /etc/systemd/system/chainfolio.service` 修改 `ExecStart`。此模板启用了 `ProtectHome=true`，不能使用位于用户 home 下的 nvm Node。

环境配置默认端口 **3089**，避免与本机现有 3088 服务冲突。数据保存在 `/var/lib/chainfolio`，由 systemd 创建并授予服务用户权限，更新代码不会覆盖数据。需要初始 RPC 时可用 `sudoedit /etc/chainfolio.env` 配置，也可以启动后在网页填写；网页保存的配置优先。不要把钱包密码放入此文件。

```sh
sudo systemd-analyze verify /etc/systemd/system/chainfolio.service
sudo systemctl daemon-reload
sudo systemctl enable --now chainfolio
sudo systemctl status chainfolio --no-pager
sudo journalctl -u chainfolio -n 50 --no-pager
```

服务应显示 `active (running)`。模板设置了异常退出重启和开机启动；手动 `systemctl stop` 不会触发自动重启。安装时如果路径、Node 版本或环境配置有误，先根据日志修复再启动。

## 4. 从自己电脑打开网页

在自己的电脑上执行，替换登录用户名和服务器地址：

```sh
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:3089:127.0.0.1:3089 USER@SERVER_IP
```

保持这个终端打开，然后在浏览器访问 **http://127.0.0.1:3089/**。这时看到的是服务器上的数据，与本机 3088 网页的数据独立。服务器只需允许你的 SSH 连接，不需要对公网开放 3089。

应用会校验 Host / Origin，因此隧道两端端口应与服务的 `PORT` 一致。3089 被占用时，同时调整服务环境配置和隧道两端端口，再重启服务。SSH 使用非默认端口时添加 `-p 端口号`。

网页里配置并测试 RPC，然后点击“自动运行”，输入钱包加密密码。ETH > 0.1 **或** BNB > 0.1 的钱包会进入高余额 Tab。关闭浏览器或断开 SSH 隧道只影响查看，服务器中的自动任务继续执行。

**服务重启、服务器重启后，网页服务会自动启动，但持续生成任务需要重新输入原钱包密码才能恢复。** 当前实现只在进程内存保存密码，并不支持重启后完全无人干预地继续生成。连续查询失败或磁盘不足引发的暂停也需要处理原因后恢复。不要通过明文密码脚本绕过这些行为。

## 5. 迁移原有钱包

GitHub 只传代码，不会带走本机钱包和 RPC 配置。需要迁移时，先暂停任务，在本机网页导出加密备份，再通过服务器网页的“备份 → 恢复备份”导入。保管好备份密码以及每批钱包的原加密密码。RPC 需要在服务器重新填写。

网页备份最多 10000 个钱包、明文最大 40MB。超过限制时，停止源服务后单独传输完整数据目录到目标 `/var/lib/chainfolio`，并修正为 `chainfolio:chainfolio` 所有权；目标服务也必须先停止，且不要覆盖已有目标数据。数据迁移独立于 Git 操作。

## 6. 更新、查看日志与备份

更新前在网页暂停自动任务，作为代码目录的部署用户执行：

```sh
cd /opt/chainfolio
git fetch origin
git log --oneline HEAD..origin/main
sudo systemctl stop chainfolio
git pull --ff-only
npm ci --omit=dev
chmod -R a+rX /opt/chainfolio
sudo systemctl start chainfolio
sudo systemctl status chainfolio --no-pager
```

逐步检查结果；拉取或依赖安装失败时先修复再启动。服务恢复后，在网页重新输入原密码继续生成。服务模板有变更时需要重新安装 service 文件并执行 `daemon-reload`；不要覆盖已经填写的 `/etc/chainfolio.env`。

常用运维命令：

```sh
sudo journalctl -u chainfolio -f
sudo systemctl stop chainfolio
sudo systemctl start chainfolio
sudo du -sh /var/lib/chainfolio
df -h /var/lib/chainfolio
```

优先使用网页加密备份。完整目录备份需先停止服务，再备份整个 `/var/lib/chainfolio`，避免遗漏 SQLite WAL；配置文件 `/etc/chainfolio.env` 另外妥善保存。持续运行会增加磁盘和 RPC 用量，请定期查看实际使用情况。

公网 IP 访问可使用 [Ubuntu + 1Panel v1 配置说明](deploy/1panel-v1.md)。程序支持通过 `PUBLIC_ORIGIN` 明确允许一个 HTTPS 公网来源，仍仅监听本机端口；反向代理必须负责 HTTPS 和全站认证，不能仅开放端口。
