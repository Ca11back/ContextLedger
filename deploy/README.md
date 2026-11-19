# 部署和运维

ContextLedger 服务有现成的 Docker 镜像：`ghcr.io/ca11back/contextledger`，支持 amd64 和 arm64，不需要自己构建。

## 快速开始

下面假设 new-api 用 Docker Compose 部署，ContextLedger 加进同一个 Compose 文件。

**1. 准备目录和配置**

在 new-api 的 `docker-compose.yml` 旁边：

```sh
mkdir -p contextledger/data
sudo chown 1000:1000 contextledger/data      # 镜像里以 UID 1000 运行
sudo chmod 700 contextledger/data            # 数据库里是完整对话，别让其他账号读
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
curl -fsS http://127.0.0.1:18740/healthz # 显示版本号和支持的协议版本
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

插件和服务端各有版本号，靠上传协议的版本对接，目前只有一版协议。以后协议升级时，新服务端会同时兼容上一版，所以**先升级服务端，再升级插件**。插件 README 里写了它需要的最低服务端版本。

升级到推荐标签以外的系列（比如从 `0.3` 改成 `0.4`）前，先看更新说明。

### 升级服务端

1. 记下现在用的镜像版本，回滚时要用：`docker compose images contextledger`。
2. 拉取新镜像，停掉旧服务：

   ```sh
   docker compose pull contextledger
   docker compose stop contextledger
   ```

3. 想另外留一份手动备份的话，用新镜像备份（旧镜像可能还没有备份命令）：

   ```sh
   docker compose run --rm --no-deps contextledger bun run server.ts backup /data/backups/before-upgrade-2026-11-19.sqlite
   ```

4. 启动并确认健康：

   ```sh
   docker compose up -d --no-deps contextledger
   docker compose ps contextledger
   curl -fsS http://127.0.0.1:18740/healthz
   ```

停机这段时间插件上传不了，会漏记，挑空闲时段升级。

新版本需要升级数据库格式时，服务会在启动前自动备份一份到 `data/backups/`，备份成功才升级。数据库大的话启动会慢一些，等状态变成 healthy 就好。备份失败（比如磁盘满了、`backups` 目录权限不是 700）时服务直接退出，旧数据不会被改动，解决问题后重新启动即可。自动备份要求数据目录所在的文件系统支持硬链接，普通 Linux 磁盘都可以，部分网络盘不行。

### 回滚

- **数据库格式没变**：把 `image` 改回记下的旧版本，`docker compose up -d --no-deps contextledger`。
- **数据库格式变了**：旧版本读不了新格式，要用升级前的备份。路径按你的挂载目录调整：

  ```sh
  data=contextledger/data
  snapshot="$data/backups/ledger-schema7-20261119T010000Z.sqlite"   # 换成实际要恢复的备份
  keep="$data/upgraded-$(date +%Y%m%d%H%M%S)"                        # 升级后的数据先移到这里留着

  docker compose stop contextledger
  sudo install -d -m 700 -o 1000 -g 1000 "$keep"
  for f in ledger.sqlite ledger.sqlite-wal ledger.sqlite-shm ledger.sqlite-journal; do
    sudo test -e "$data/$f" && sudo mv "$data/$f" "$keep/"
  done
  sudo install -m 600 -o 1000 -g 1000 "$snapshot" "$data/ledger.sqlite"
  # 把 compose 里的 image 改回记下的旧版本
  docker compose up -d --no-deps contextledger
  docker compose ps contextledger
  ```

  升级之后新记下的内容不在旧备份里，回滚后网页上看不到，但还留在 `$keep` 目录里。确认不需要了再删。

## 备份

服务运行时备份：

```sh
docker compose exec contextledger bun run server.ts backup /data/backups/manual-2026-11-19.sqlite
```

服务停止时备份：

```sh
docker compose run --rm --no-deps contextledger bun run server.ts backup /data/backups/manual-2026-11-19.sqlite
```

- 每次用新文件名，目标已存在会拒绝（`backup_destination_exists`）。
- 运行时备份期间数据库没法整理日志文件，流量大时可能有几条上传被暂时拒绝（HTTP 507）而漏记。尽量挑空闲时段；不能接受漏记的话，停服务再备份。
- `backups` 目录权限必须是 700，服务会自动创建。自动备份（升级前那种）只保留最近两份；手动备份不会自动删除，自己清理。
- 备份里是完整的对话内容，和数据库一样要保管好。

恢复：按上面「数据库格式变了」的步骤，把要恢复的备份放回去。

## 磁盘空间

`LEDGER_MAX_STORAGE_MB` 只限制数据库本身（含 `-wal`、`-shm`），快满时自动从最旧的记录开始删。备份、日志和镜像另算。

按存储上限 10 GB 估算：数据库本身、保留的两份自动备份、升级时正在写的新备份，每份都可能接近 10 GB，这几项合计约 40 GB。在此之外再给数据库升级留些余量，加上你的手动备份、日志、镜像和同一块盘上的其他服务。调低过存储上限，或者备份来自更大的旧库时，按实际文件大小算。

如果遇到 SQLite 临时空间不足的错误，可以设置 `SQLITE_TMPDIR` 指向 `/data` 下一个已存在的目录，不要直接把内存里的 `/tmp` 调大。

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

源码仓库里的 `scripts/integrity.ts` 可以检查所有数据能否完整还原，镜像里没有，要用和服务**相同版本**的源码运行（不同版本可能会顺手升级数据库格式）。

1. 停掉服务。
2. 复制一份服务用的 `ledger.env`（权限 `0600`），把里面的 `LEDGER_DATABASE` 改成宿主机上数据库文件的绝对路径，其他配置保持不变。
3. 在源码根目录执行：

```sh
bun --env-file=/secure/maintenance.env run integrity             # 只检查
bun --env-file=/secure/maintenance.env run integrity --rebuild   # 检查通过后修复计数
```
