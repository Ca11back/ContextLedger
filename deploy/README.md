# 部署和运维

## 打包

在本机（不是服务器上）构建并打包运行时：

```sh
bun install --frozen-lockfile
bun run check
mkdir -p artifacts
bun run package:runtime --output artifacts/contextledger
```

生成的目录里有 `dist/`、`server.ts`、`Dockerfile` 和一份文件 SHA-256 清单。运行时不需要 `node_modules`，服务器上也不用装依赖或重新构建。

## 用 Docker 运行

```sh
docker build -t contextledger:local artifacts/contextledger
```

然后二选一：

- **加进 new-api 的 Compose**：参考 [compose.example.yaml](compose.example.yaml)，把打包目录放到 `./contextledger/runtime/`。
- **单独运行**：自己 `docker run`，挂载一个数据目录到 `/data`，传入环境变量文件即可。

数据目录要让镜像里的 `bun` 用户（UID 1000）能写。

使用 Compose 时，在部署机器上保留现有的 `services` 和网络定义，只合入示例中的 `contextledger` 服务并匹配 new-api 的实际网络。示例底部的外部网络定义仅适用于已有的外部网络，不要覆盖现有网络配置。相对于该 Compose 文件准备 `contextledger/runtime/`、`contextledger/ledger.env` 和 `contextledger/data/`，并在同一部署机器上用前面的 `docker build` 命令构建 `contextledger:local`（将构建目录改成实际的运行时目录）。填好下文配置后，检查并只启动该服务：

```sh
docker compose -f /path/to/docker-compose.yml config --quiet
docker compose -f /path/to/docker-compose.yml up -d --no-deps --no-build --pull never contextledger
```

随后打开 `http://127.0.0.1:18740/`；远程访问使用下文的 SSH 转发。

## 配置

从 [ledger.env.example](ledger.env.example) 复制一份，权限设成 `0600`，填上自己生成的密码和令牌。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `LEDGER_ADMIN_USER` | 否 | 网页登录账号，默认 `admin` |
| `LEDGER_ADMIN_PASSWORD` | 是 | 网页登录密码，至少 16 个字符 |
| `LEDGER_INGEST_TOKEN` | 是 | 插件上传用的令牌，至少 24 个字符，不要和密码相同 |
| `LEDGER_SOURCE` | 是 | 数据来源名称，要和插件里填的 `source` 一致 |
| `LEDGER_DATABASE` | 否 | SQLite 文件路径，源码运行默认 `./data/ledger.sqlite`，镜像默认 `/data/ledger.sqlite` |
| `LEDGER_MAX_STORAGE_MB` | 是 | 存储上限，正整数，十进制 MB（1 MB = 1,000,000 字节）；`10000` 表示 10 GB。快满时自动从最旧的记录开始删 |
| `LEDGER_HOST` / `PORT` | 否 | 监听地址和端口 |
| `LEDGER_MAX_AGE_DAYS` | 否 | 记录最多保留几天，默认不限 |
| `LEDGER_MAX_BODY_BYTES` | 否 | 单次上传大小上限，默认 1 MiB |
| `LEDGER_RESERVE_BYTES` | 否 | 额外预留空间 |
| `LEDGER_MAINTENANCE_MS` | 否 | 后台维护间隔，默认 30 秒 |

存储上限只管数据库本身（含索引和 WAL），镜像、日志、备份要另外留磁盘空间。

## 安全

- 网页和查询接口用 HTTP Basic 认证保护，插件上传用单独的 Bearer 令牌。
- 默认按「只在本机访问」设计。要从外网访问，请自己在前面加 TLS，或者干脆用 SSH 端口转发：

  ```sh
  ssh -N -L 18740:127.0.0.1:18740 <你的服务器>
  ```

## 接口

| 接口 | 认证 | 用途 |
| --- | --- | --- |
| `GET /healthz` | 无 | 健康检查 |
| `POST /api/ingest` | Bearer | 插件上传（先发清单，再补传缺的片段） |
| `GET /api/uploads` | Basic | 上传状态：没传完、已过期、已完成 |
| `GET /api/conversations` | Basic | 会话列表，支持用户、令牌、模型、状态、时间和主对话/子代理筛选 |
| `GET /api/conversations/:id` | Basic | 会话概要、内容分支与客户端声明的子代理来源 |
| `GET /api/conversations/:id/turns` | Basic | 分页读取轮次；`startTurn` 可直接定位请求 |
| `GET /api/conversations/:id/fragments` | Basic | 分页读取消息描述和各文本部分的首块 |
| `GET /api/conversations/:id/branches` / `subagents` | Basic | 分页读取内容分支或客户端声明的直接子代理 |
| `GET /api/text/:continuation` | Basic | 按续读令牌读取下一块文本；响应给出下一枚令牌，末尾为 `null` |
| `GET /api/requests` | Basic | 请求列表，附所属会话与轮次；非对话请求没有所属会话 |
| `GET /api/lookup?q=<请求编号>` | Basic | 按 new-api 请求编号精确定位；编号重复时返回候选 |
| `GET /api/records/:id/view` | Basic | 分段查看一条记录 |
| `GET /api/metrics` | Basic | 存储用量和压力 |

新增会话接口按实际 JSON 字节数限制每页最多 64 KiB；`cursor` 和文本续读令牌由服务端生成，不要自行修改。原来的记录列表和整条记录接口已移除，原始内容通过分段查看接口读取。

## 校验和备份

校验工具位于源码仓库的 `scripts/integrity.ts`，不包含在精简运行时目录或镜像里。使用与运行服务相同版本的源码和 Bun，在源码根目录执行 `bun install --frozen-lockfile` 准备依赖。

先停掉使用该数据库的服务（Compose 部署用 `docker compose -f /path/to/docker-compose.yml stop contextledger`）。准备一个权限为 `0600` 的专用环境文件，保留必填配置，并将 `LEDGER_DATABASE` 设成该机器上实际数据库文件的**绝对路径**。容器内的 `/data/ledger.sqlite` 通常需要改成宿主机挂载目录中的路径；先确认文件存在且当前用户有读写权限，避免误创建空库。然后在源码根目录执行：

```sh
bun --env-file=/secure/maintenance.env run integrity                                   # 校验所有数据能完整还原
bun --env-file=/secure/maintenance.env run integrity --rebuild                         # 校验通过后修复计数
bun --env-file=/secure/maintenance.env run integrity --backup /另一块盘/backup.sqlite   # 生成一致的备份快照
```

备份不会覆盖已有文件，也不会自动定时运行。恢复时把备份放到新位置，将专用环境文件的 `LEDGER_DATABASE` 改成恢复文件的绝对路径，再跑一遍校验。操作完成后恢复数据库文件所需权限，再只启动 `contextledger` 服务。

## 已知限制

- 同一个数据库只能有一个服务进程。
- new-api 对回复内容最多截取约 1 MiB；网关排队满、重启或上传失败时，个别请求可能漏记。
- 插件 `ca11back_contextledger` 0.3.0 配合服务端 0.3.0 使用。
