# 部署和运维

ContextLedger 服务有现成的 Docker 镜像：`ghcr.io/ca11back/contextledger`，支持 amd64 和 arm64，不需要自己构建。

## 快速开始

下面假设 new-api 用 Docker Compose 部署，ContextLedger 加进同一个 Compose 文件。

**1. 准备目录和配置**

在 new-api 的 `docker-compose.yml` 旁边：

```sh
mkdir -p contextledger/data
sudo chown 1000:1000 contextledger/data      # 镜像里以 UID 1000 运行
curl -fsSL -o contextledger/ledger.env https://raw.githubusercontent.com/Ca11back/ContextLedger/main/deploy/ledger.env.example
chmod 600 contextledger/ledger.env
```

打开 `contextledger/ledger.env`，把密码和令牌换成你自己生成的（两个不能一样），例如用 `openssl rand -base64 24` 生成。

**2. 加入 Compose**

把下面这段加到 `services:` 下面，网络名换成 new-api 实际用的网络。完整示例见 [compose.example.yaml](compose.example.yaml)。

```yaml
  contextledger:
    image: ghcr.io/ca11back/contextledger:0.3
    container_name: contextledger
    restart: unless-stopped
    networks:
      - default                          # 换成 new-api 所在的网络
    ports:
      - "127.0.0.1:18740:3000"           # 只在本机开放
    env_file:
      - ./contextledger/ledger.env
    volumes:
      - ./contextledger/data:/data
```

启动：

```sh
docker compose up -d contextledger
docker compose ps contextledger          # 状态变成 healthy 就是启动好了
```

**3. 配置插件**

在 new-api 后台安装 ContextLedger 插件，新建一个请求处理实例：

- 接收地址：`http://contextledger:3000/api/ingest`
- 上传令牌：`ledger.env` 里的 `LEDGER_INGEST_TOKEN`
- 来源名称：`ledger.env` 里的 `LEDGER_SOURCE`

**4. 打开网页**

在服务器上打开 `http://127.0.0.1:18740/`。不在服务器本机的话，用 SSH 转发：

```sh
ssh -N -L 18740:127.0.0.1:18740 <你的服务器>
```

然后在自己电脑上打开同样的地址。用户名默认 `admin`，密码是 `LEDGER_ADMIN_PASSWORD`。

## 版本和升级

镜像标签：

| 标签 | 含义 |
| --- | --- |
| `0.3` | 0.3 系列的最新修复版，**推荐** |
| `0.3.0` | 固定这一个版本 |
| `latest` | 最新版本，可能包含不兼容的变化，不建议用 |

插件和服务端各有版本号，靠上传协议的版本对接。服务端会兼容上一版协议，所以**先升级服务端，再升级插件**，顺序反过来可能会有一段时间漏记。插件 README 里写了它需要的最低服务端版本。

升级服务端：

```sh
docker compose exec contextledger bun run server.ts backup /data/backups/before-upgrade.sqlite
docker compose pull contextledger
docker compose up -d contextledger
```

改成新的大版本（比如 `0.3` 改 `0.4`）前，先看更新说明。

新版本需要升级数据库格式时，服务会在启动前自动备份一份到 `data/backups/`，备份成功才升级。数据库大的话启动会慢一些，等它开始监听就好。备份失败（比如磁盘满了）时服务直接退出，旧数据不会被改动，解决问题后重启即可。

`docker compose exec contextledger wget -qO- http://127.0.0.1:3000/healthz` 可以看到当前版本和支持的协议版本。

### 回滚

- **数据库格式没变**：把 `image` 改回旧标签，`docker compose up -d contextledger`。
- **数据库格式变了**：旧版本读不了新格式，要用升级前的备份：

  ```sh
  docker compose stop contextledger
  mkdir -p contextledger/rolled-back
  mv contextledger/data/ledger.sqlite* contextledger/rolled-back/      # 连同 -wal、-shm 一起移走
  cp contextledger/data/backups/<升级前的备份>.sqlite contextledger/data/ledger.sqlite
  sudo chown 1000:1000 contextledger/data/ledger.sqlite
  # 把 image 改回旧标签
  docker compose up -d contextledger
  ```

  升级之后新记下的内容不在旧备份里，回滚后就没有了。

## 备份

服务运行时备份：

```sh
docker compose exec contextledger bun run server.ts backup /data/backups/2026-11-19.sqlite
```

服务停止时备份：

```sh
docker compose run --rm --no-deps contextledger bun run server.ts backup /data/backups/2026-11-19.sqlite
```

- 每次用新文件名，目标已存在会拒绝（`backup_destination_exists`）。
- 运行时备份会短暂拖住写入，流量大时可能有几条上传被暂时拒绝而漏记。尽量挑空闲时段；不能接受漏记的话，停服务再备份。
- 自动备份（升级前那种）只保留最近两份；手动备份不会自动删除，自己清理。
- 备份里是完整的对话内容，和数据库一样要保管好。

恢复：停服务，按上面「数据库格式变了」的步骤把备份放回 `data/ledger.sqlite`。

## 磁盘空间

`LEDGER_MAX_STORAGE_MB` 只限制数据库本身，快满时自动从最旧的记录开始删。备份、镜像和日志另算。升级时会同时存在数据库、两份旧的自动备份和一份新备份，所以磁盘至少要留出存储上限的 4 倍空间，再加上你自己的手动备份。

## 配置

从 [ledger.env.example](ledger.env.example) 复制，权限设成 `0600`。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `LEDGER_ADMIN_USER` | 否 | 网页登录账号，默认 `admin` |
| `LEDGER_ADMIN_PASSWORD` | 是 | 网页登录密码，至少 16 个字符 |
| `LEDGER_INGEST_TOKEN` | 是 | 插件上传用的令牌，至少 24 个字符，不要和密码相同 |
| `LEDGER_SOURCE` | 是 | 数据来源名称，要和插件里填的一致 |
| `LEDGER_MAX_STORAGE_MB` | 是 | 存储上限，十进制 MB；`10000` 就是 10 GB |
| `LEDGER_MAX_AGE_DAYS` | 否 | 记录最多保留几天，默认不限 |
| `LEDGER_DATABASE` | 否 | 数据库路径，镜像里默认 `/data/ledger.sqlite`，自动备份放在同目录的 `backups/` |
| `LEDGER_HOST` / `PORT` | 否 | 监听地址和端口，镜像里是 `0.0.0.0:3000` |
| `LEDGER_MAX_BODY_BYTES` | 否 | 单次上传大小上限，默认 1 MiB |
| `LEDGER_RESERVE_BYTES` | 否 | 额外预留空间 |
| `LEDGER_MAINTENANCE_MS` | 否 | 后台维护间隔，默认 30 秒 |

## 安全

- 网页用账号密码登录，插件上传用单独的令牌。
- 默认只在本机开放端口。要从外网访问，请自己在前面加 HTTPS 和访问控制，或者用 SSH 转发。
- 数据库和备份里是完整的对话内容，注意目录权限和谁能登录服务器。

## 已知限制

- 同一个数据库只能有一个服务进程。升级时先停旧的再起新的（`docker compose up -d` 会自动这样做）。
- new-api 交给插件的回复最多约 1 MiB；网关排队满、重启或上传失败时，个别请求可能漏记。

## 附录：从源码构建

需要 [Bun](https://bun.sh) 1.4.4。

```sh
bun install --frozen-lockfile
bun run check
bun run package:runtime --output artifacts/contextledger
docker build -t contextledger:local artifacts/contextledger
```

Compose 里把 `image` 换成 `contextledger:local`。

## 附录：数据校验

源码仓库里的 `scripts/integrity.ts` 可以检查所有数据能否完整还原，镜像里没有。用和服务相同版本的源码，停掉服务，准备一个 `LEDGER_DATABASE` 指向数据库文件绝对路径的环境文件（权限 `0600`），在源码根目录执行：

```sh
bun --env-file=/secure/maintenance.env run integrity             # 只检查
bun --env-file=/secure/maintenance.env run integrity --rebuild   # 检查通过后修复计数
```
