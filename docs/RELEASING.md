# 提交与发版约定

## 提交

- 提交信息用 Conventional Commits：`feat:`、`fix:`、`docs:`、`chore:`、`test:`、`refactor:`，标题说明用户能感知到的变化，正文写原因。
- 一次提交只做一件事；提交前 `bun run check` 必须通过。
- 不提交私有信息：服务器地址、账号、令牌、真实对话内容。截图和测试数据只用虚构数据（`tests/support/seed-demo.ts`）。

## 插件发版（new-api 社区插件市场）

市场按仓库里的版本 tag 收录插件，并在该 tag 的提交上检查 `plugins/ca11back_contextledger/` 下的文件，检查不过就拒收这个版本。

开发阶段不发版、不打 tag：插件代码有变化时，只把变化记进当前未发布版本的更新日志。等决定正式提交到社区时，再定版本号并打第一个 tag。

正式发一个版本时：

1. `plugin.js` 里的 `meta.version` 改成新版本号（语义化版本），`meta.key` 保持 `ca11back_contextledger`。
2. `CHANGELOG.md` 和 `CHANGELOG.zh-CN.md` 只写这一个版本：开头的 `plugin` / `version` 与 `plugin.js` 一致；分类只用 `Added`、`Changed`、`Deprecated`、`Removed`、`Fixed`、`Security`、`Migration`，按这个顺序。
3. `README.md`（英文，必需）和 `README.zh-CN.md` 说明当前行为；不含 HTML、图片；第一行是一级标题。
4. `meta.description` 每种语言不超过约 80 列（中文约 40 字）。
5. `bun run check` 通过后提交，在这次提交上打 tag，例如 `v0.3.0`（发布前在 newapi.ai 作者页确认 tag 规则），然后推送提交和 tag。
6. 插件和服务端要配套时，在 README 写明需要的服务端最低版本。

已经被市场收录的 tag 不要移动；要修正就发新版本。
