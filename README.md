# ContextLedger

给 [new-api](https://github.com/QuantumNous/new-api) 用的对话记录本。

new-api 自带的日志只记「谁、什么时候、用了多少 token」，不记聊了什么。ContextLedger 把每次请求和回复的内容存下来，管理员可以在网页上翻看：用户发了什么，模型回了什么。

## 由两部分组成

- **插件**（[plugins/new-api-report.js](plugins/new-api-report.js)）：装在 new-api 里。每次请求结束，它把内容整理一下，发给记录服务。
- **记录服务**：一个独立的小程序，负责收、存，并提供一个只有管理员能登录的网页。

## 存哪些内容

插件会先把内容精简一下，只留人看得懂、有审计价值的部分：

- **加密字段不存**。像 `encrypted_content` 这种，人看不懂，也没法审计。
- **流式回复只存最终结果**。只要最终回复确实包含了中间那些零碎片段的内容，就只存最终版。
- **图片不存原图**。new-api 自己会把图片换成 `[media:N]` 这样的占位符。

## 大对话怎么传

长对话每次请求都会把之前的聊天记录整个带上，越聊越大。如果每次都整个重传，既慢又占空间。所以：

1. 插件先把内容切成小块，给每块算一个「指纹」，然后只把指纹清单发过去。
2. 记录服务对照一下，回复「这几块我还没有」。
3. 插件只补传缺的那几块。

聊得越久，之前的内容大多已经存过，每次要补传的就越少。相同的内容在库里也只存一份，再用 zstd 压缩。

**关于大小限制**：不是说一条记录最大只能 1 MiB。new-api 限制插件每次请求最多发 4 次 HTTP 请求，每次最多 1 MiB。所以插件每次最多先发 1 次清单，再补传 3 批内容，也就是一次最多补传约 3 MiB 的**新**内容。

如果一段全新的对话一上来就超过这个量，这次只能先传一部分，网页上会标成「没传完」。同一段对话的下一次请求会接着补，补齐了就自动变成完整记录。没传完的记录最多保留 1 小时，期间一直没人补齐就作废。

## 可能漏记的情况

- new-api 本身最多只截取约 1 MiB 的回复内容交给插件。这是 new-api 的限制，超出的部分插件拿不到，跟上面说的上传方式无关。
- 网关太忙、重启或者网络出错时，个别请求可能漏记。
- 存下来的是插件整理后发过来的内容，不是网关上原始的网络数据。

没传完的记录会单独列出来，不会冒充完整记录。

## 空间管理

设一个总容量上限，比如 10 GB。快满了就从最旧的记录开始删，不用手动清理。

## 本地运行

需要 [Bun](https://bun.sh) 1.4.4。

```sh
bun install --frozen-lockfile
bun run check   # 代码检查、类型检查、测试、构建，一次跑完
```

新建一个 `.env` 文件，不要提交到仓库。密码和令牌自己生成，两个不能一样：

```text
LEDGER_SOURCE=my-gateway                # 数据来源名，随便起
LEDGER_MAX_STORAGE_MB=10000             # 容量上限，10000 MB 就是 10 GB
LEDGER_ADMIN_PASSWORD=<至少 16 个字符>   # 登录网页用
LEDGER_INGEST_TOKEN=<至少 24 个字符>     # 插件上传用
LEDGER_HOST=127.0.0.1
PORT=3000
```

启动：

```sh
bun --env-file=.env run start
```

浏览器打开 `http://127.0.0.1:3000/`，用户名 `admin`，密码就是上面设的那个。

网页没考虑直接放到公网上，建议只在本机监听。要远程访问，可以用 SSH 端口转发。

## 接到 new-api 上

1. 部署记录服务，保证 new-api 能访问到它，比如放进同一个 Docker 网络。步骤见 [deploy/README.md](deploy/README.md)。
2. 在 new-api 后台的「插件」页面上传 [plugins/new-api-report.js](plugins/new-api-report.js)。
3. 新建一个请求处理实例，填三项：
   - `url`：记录服务的接收地址，例如 `http://contextledger:3000/api/ingest`
   - `token`：上面设的 `LEDGER_INGEST_TOKEN`
   - `source`：和上面的 `LEDGER_SOURCE` 填一样的
4. 启用实例。之后有请求经过，刷新记录服务的网页就能看到。

插件 0.2.0 要配合服务端 0.3.0 用。旧的 0.1.0 插件和它不兼容。

## 更多

打包、Docker 部署、全部配置项、接口列表、数据校验和备份，都在 [deploy/README.md](deploy/README.md)。

技术栈：Bun、TanStack Start、React、Rsbuild、SQLite、zstd。

## 许可证

[MIT License](LICENSE) · Copyright (c) 2026 Ca11back
