# Ubuntu + 1Panel v1 公网 IP 访问

目标地址：`https://45.144.136.146`。以下是待执行的服务器配置步骤；本地代码已支持 `PUBLIC_ORIGIN`，但并未连接服务器或修改你的 1Panel。

访问路径：浏览器 → OpenResty 的 HTTPS 与密码验证 → 本机 `127.0.0.1:3089` → 钱包程序。

## 1. 部署程序

先按 [部署说明](../DEPLOYMENT.md) 上传代码、安装依赖和 systemd 服务。这里沿用 `/opt/chainfolio`、`/etc/chainfolio.env` 和 `/var/lib/chainfolio`。

通过 1Panel 终端或 SSH 编辑服务器的 `/etc/chainfolio.env`，保留原有 RPC 配置，添加或修改这些项，不要重复定义：

```dotenv
PORT=3089
DATA_DIR=/var/lib/chainfolio
PUBLIC_ORIGIN=https://45.144.136.146
```

重启会暂停自动生成，需要重新输入原钱包密码：

```sh
sudo systemctl restart chainfolio
sudo systemctl status chainfolio --no-pager
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3089/
```

最后一条命令应返回 200。

`PUBLIC_ORIGIN` 只接受完整 HTTPS 来源，可带端口；不能包含路径、用户名密码或通配符。它是访问地址校验配置，**不是登录认证**。

## 2. 创建 1Panel 网站

在“应用商店”确认 OpenResty 已安装；不要再安装另一个占用 80/443 的 Nginx。然后进入“网站 → 创建网站 → 反向代理”：

| 设置 | 值 |
| --- | --- |
| 主域名/网站地址 | `45.144.136.146`（不带协议） |
| 代号 | `chainfolio` |
| 代理协议（输入框前的下拉框） | `http://` |
| 代理地址（已有协议下拉框时） | `127.0.0.1:3089`，不再填写协议 |
| 代理路径 | `/` |
| 缓存 | 关闭 |

如果界面只有一个完整 URL 输入框、没有单独协议选项，才填写 `http://127.0.0.1:3089`。生成的配置必须为 `proxy_pass http://127.0.0.1:3089;`，只能有一个 `http://`。出现 `invalid port in upstream "http://127.0.0.1:3089"` 时，先检查是否被拼接成 `http://http://127.0.0.1:3089`；修正输入或该站点 `proxy/root.conf` 中对应的 `proxy_pass` 行，再在面板保存并检查配置。

如果该 IP 已绑定到其他网站，不要覆盖已有站点；可改用未占用的 HTTPS 端口，例如 8443，并把 `PUBLIC_ORIGIN` 改成 `https://45.144.136.146:8443`。

本方案要求 OpenResty 使用宿主机网络（host）。可在“容器”中检查网络模式；桥接网络里的 `127.0.0.1` 指容器自身，无法访问宿主机的回环端口。若当前不是 host，先检查已有站点依赖再调整网络，不要通过把钱包服务开放到公网来解决 502。

进入这个网站的配置，在“密码访问”中设置覆盖全站的独立账号密码，确认 `/api/` 也受保护。这个密码不同于 1Panel 登录密码，也不同于钱包加密密码。先完成认证和 HTTPS，再对外使用。

菜单以 [1Panel v1 创建网站](https://1panel.cn/docs/v1/user_manual/websites/website_create/) 和 [基本设置](https://1panel.cn/docs/v1/user_manual/websites/website_config_basic/) 为参考，小版本的字段名称可能略有不同。

## 3. 代理参数

在该网站的反向代理配置中，确认有效的 `location /` 包含以下参数。合并到现有配置，替换同名项，**不要另加第二个 `location /` 或删除面板生成的密码验证设置**：

```nginx
proxy_pass http://127.0.0.1:3089;
proxy_set_header Host $http_host;
proxy_set_header Origin $http_origin;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 180s;
proxy_send_timeout 180s;
proxy_cache off;
proxy_buffering off;
proxy_request_buffering off;
client_max_body_size 64m;
```

保留浏览器的 Host 和 Origin，应用才能验证真实访问地址。不要把 Origin 固定改成 localhost，也不要关闭程序的来源校验。备份恢复可能超过默认上传大小，所以这里放宽到 64MB；应用自身仍执行 60MB 请求限制。

## 4. HTTPS 与 IP 证书

“网站 → 配置 → HTTPS”选择包含 `45.144.136.146` 的 IP 证书，设置 HTTP 自动跳转 HTTPS。域名证书不能用于该 IP。配置后浏览器应直接信任证书，不应靠忽略证书错误来使用钱包。

不能假设 1Panel v1 自带的 ACME 客户端支持 IP 证书。如果已有有效 IP 证书，可通过该页面导入；否则可使用 **Certbot 5.4 或更高版本**，通过 webroot 申请。以下命令仅在 HTTP 验证目录映射正确后运行：

```sh
certbot --version
sudo certbot certonly --preferred-profile shortlived --webroot \
  --webroot-path /REPLACE_WITH_HOST_WEBROOT \
  --ip-address 45.144.136.146
```

`/REPLACE_WITH_HOST_WEBROOT` 必须替换成此站点**宿主机上的真实静态根目录**，不是代码目录或容器内路径。配置 OpenResty 将 `/.well-known/acme-challenge/` 映射到它对应的容器内目录，并仅对此验证路径免认证、避免转发给钱包程序。先放置测试文本，确认从公网 HTTP 可以读取同一路径，再申请。不要给整个站点关闭密码验证。

Let’s Encrypt 的 IP 证书有效期约 6 天。申请后将 `fullchain.pem` 与 `privkey.pem` 部署到 OpenResty 可读取的证书目录，并在 1Panel 中选择它们。**还需配置 Certbot 自动续期以及 deploy hook：成功续期后更新实际使用的证书文件，检查 OpenResty 配置并 reload。** 仅在面板中粘贴一次证书不会自动更新。容器名、证书挂载路径和 webroot 必须从你的面板实际配置确认，不能套用猜测的路径。

确认续期计划任务存在，运行 `sudo certbot renew --dry-run` 验证续期；证书部署 hook 也应单独验证，并检查网站实际返回的证书有效期。官方流程：[Certbot IP 证书说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)。

## 5. 放行端口和检查

在 1Panel 防火墙和云厂商安全组中放行网站的 TCP 443，以及 HTTP-01 验证需要的 TCP 80。保留现有 SSH/面板规则，钱包内部 3089 不开放公网。

配置完成后，用未登录的客户端验证：

```sh
# 未携带网站密码，应该返回 401，不能返回钱包数据。
curl -s -o /dev/null -w '%{http_code}\n' https://45.144.136.146/api/state
```

然后浏览器打开 `https://45.144.136.146`，输入网站账号密码，确认网页和 API 都正常，再配置 RPC 并启动自动运行。

- **502**：检查钱包服务、3089 端口以及 OpenResty 网络模式。
- **403 不允许的主机/来源**：检查 `PUBLIC_ORIGIN`、实际访问协议/端口和转发的 Host/Origin；修改环境后需重启。
- **401**：网站认证尚未通过；如果首页认证后 API 仍无法访问，检查 API 路径的认证配置。
- **413/504**：检查实际生效的上传大小和代理超时配置。
- **证书错误**：检查证书是否包含这个 IP、是否过期及续期后是否更新到了实际使用路径。

关闭网页不停止服务器自动任务。重启服务后，需要在网页重新输入原钱包密码才能继续生成。
