# ContextLedger

给 [new-api](https://github.com/QuantumNous/new-api) 用的「对话账本」：把经过网关的每一次大模型请求和回复存下来，让管理员事后能翻出来看——用户到底发了什么、模型到底回了什么。

## 它解决什么问题

new-api 自带的日志只记谁、什么时候、用了多少 token，不记内容。出了问题想回头查「这次对话里到底说了什么」，往往查不到。

ContextLedger 由两部分组成：

- **一个 new-api 插件**（[plugins/new-api-report.js](plugins/new-api-report.js)）：每次请求结束后，把请求和回复的内容整理好，发给 ContextLedger。
- **一个独立的小服务**：负责接收、存储，并提供一个只有管理员能打开的网页，用来筛选和查看记录。

## 存了什么，没存什么

为了让记录**人能看懂、存得下**，插件发送前会做一些精简：

- **会去掉** `encrypted_content` 这类加密字段——人看不懂，也没法审计。
- **流式回复只留最终结果**：如果最终的完整回复能证明覆盖了中间那一大串流式片段，就只存最终版，不重复存。
- **图片等大块媒体** 由 new-api 自己替换成占位符（如 `[media:N]`），不存原图。

另外要知道的边界：

- 存下来的是「ContextLedger 收到的内容」，不是网关上原始的 HTTP 字节。new-api 本身对回复的截取有上限（约 1 MiB），超出部分本来就拿不到。
- 网关繁忙、重启或上传失败时，个别请求可能会漏记。网页上会单独显示「没传完」的上传，不会把半截数据当成完整记录。

## 怎么做到又省空间又不卡

- **只传缺的部分**：一段长对话每次请求都会把之前的历史带上。插件先发一份「清单」，服务端回复哪些片段还没有，插件只补传缺的。很多轮之后，大部分历史已经存过，基本不用重传。每次上传都控制在 1 MiB 以内。
- **相同内容只存一份**：内容被切成小片段，按哈希去重，再用 zstd 压缩。
- **空间满了自动清最旧的**：设一个总容量上限（比如 10 GB），快满时从最老的记录开始删。
- **大记录分段看**：网页上打开一条很大的记录时，消息按页加载、长文本按段加载，浏览器不会被一次性撑爆。

## 本地运行

需要 [Bun](https://bun.sh) 1.4.4。

```sh
bun install --frozen-lockfile
bun run check   # 代码检查 + 类型检查 + 测试 + 构建
```

新建一个 `.env`（不要提交到仓库），密码和令牌请自己生成，两者不要相同：

```text
LEDGER_DATABASE=./data/ledger.sqlite
LEDGER_MAX_STORAGE_MB=10000             # 存储上限，10000 MB = 10 GB
LEDGER_SOURCE=my-gateway                # 给这个数据来源起个名字
LEDGER_ADMIN_USER=admin
LEDGER_ADMIN_PASSWORD=<至少 16 个字符>   # 登录网页用
LEDGER_INGEST_TOKEN=<至少 24 个字符>     # 插件上传用
LEDGER_HOST=127.0.0.1
PORT=3000
```

`LEDGER_MAX_STORAGE_MB` 必须是正整数，按十进制计算：1 MB = 1,000,000 字节。

启动：

```sh
bun --env-file=.env run start
```

浏览器打开 `http://127.0.0.1:3000/`，用上面的管理员账号登录。

网页没有做公网防护设计，建议只监听本机，远程访问时用 SSH 端口转发。

## 接到 new-api 上

1. 部署 ContextLedger 服务，确保 new-api 能访问到它（比如放进同一个 Docker 网络）。具体步骤见 [deploy/README.md](deploy/README.md)。
2. 在 new-api 后台的「插件」页面上传 [plugins/new-api-report.js](plugins/new-api-report.js)。
3. 新建一个请求处理实例，填三项：
   - `url`：ContextLedger 的接收地址，例如 `http://contextledger:3000/api/ingest`
   - `token`：上面的 `LEDGER_INGEST_TOKEN`
   - `source`：数据来源名称
4. 启用实例。之后有真实请求经过时，刷新 ContextLedger 网页就能看到记录。

插件 0.2.0 和服务端 0.3.0 配套使用；旧的 0.1.0 插件协议不兼容。

## 更多细节

- 部署和运维（打包、Docker/Compose 示例、配置项、接口列表、校验和备份）：[deploy/README.md](deploy/README.md)

## 技术栈

Bun · TanStack Start · React · Rsbuild · SQLite · zstd

## 许可证

[MIT License](LICENSE) · Copyright (c) 2026 Ca11back
