---
changelogVersion: 1
plugin: "ca11back_contextledger"
version: "0.3.0"
locale: "zh-CN"
---
# Changelog

## [0.3.0]

### Added

- 把每次请求和回复的内容发到自建的 ContextLedger 服务，供管理员翻看。
- 大对话分块上传：先发指纹清单，再只补传服务还没有的部分。
- 不存 `encrypted_content` 这类加密字段；流式回复的最终结果能覆盖全部片段时，只存最终结果。
- 不上报 embedding 请求（`format=embedding`），它们不会发送到 ContextLedger。
