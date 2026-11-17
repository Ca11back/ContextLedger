---
locale: zh-CN
---
# ContextLedger

new-api 的日志只记谁调了哪个模型、用了多少 token，不记聊了什么。这个插件把每次请求和回复的内容发到你自己部署的 [ContextLedger](https://github.com/Ca11back/ContextLedger) 服务，管理员可以在网页上翻看和筛选。

## 安装前

插件只负责发送。你需要先部署好 ContextLedger 服务，并且 new-api 能访问到它，比如放在同一个 Docker 网络里。部署步骤见[部署说明](https://github.com/Ca11back/ContextLedger/blob/main/deploy/README.md)。

- 在 new-api v1.0.0-rc.51 上测试过。
- 需要 ContextLedger 服务 0.3.0 或更新版本。
- 它不是渠道类型，不需要任何厂商账号或 API Key。

## 配置

1. 安装插件。
2. 为它新建一个请求处理实例，填三项：
   - **接收地址**：服务的上传地址，例如 `http://contextledger:3000/api/ingest`。
   - **上传令牌**：服务上设置的 `LEDGER_INGEST_TOKEN`。
   - **来源名称**：和服务上的 `LEDGER_SOURCE` 填一样的。
3. 选好这个实例对哪些请求生效，然后启用。

客户端不需要做任何改动。之后有请求经过网关，刷新 ContextLedger 网页就能看到。

## 存哪些内容

插件会先精简一下，让记录人能看懂：

- 不存 `encrypted_content` 这类加密字段，人看不懂，也没法审计。
- 流式回复只要最终结果确实包含了流式片段的全部内容，就只存最终结果。
- 不发送图片。new-api 已经把图片换成了 `[media:N]` 这样的占位符。

插件不会发送插件配置和请求头。

## 大对话怎么传

长对话每次请求都会带上全部历史。插件把内容切成小块，先只发一份指纹清单。服务回复哪些块还没有，插件只补传这些。对话聊得越久，每次要传的就越少。

## 限制

- new-api 规定插件每次请求最多发 4 次 HTTP 请求，每次最多 1 MiB，所以一次请求最多补传约 3 MiB 新内容。更大的新对话会先标成「没传完」，由同一段对话后面的请求接着补齐。1 小时内没补齐的会被丢弃。
- new-api 每条回复最多交给插件约 1 MiB，超出部分存不下来。
- 网关繁忙、重启或者上传失败时，个别请求可能漏记。
- 内容会发往你配置的地址，请走内网或 HTTPS。

Embedding 请求（`format=embedding`）不会发送到 ContextLedger。
