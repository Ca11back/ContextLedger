---
changelogVersion: 1
plugin: "ca11back_contextledger"
version: "0.3.0"
locale: "en"
translations:
  zh-CN: CHANGELOG.zh-CN.md
---
# Changelog

## [0.3.0]

### Added

- Send the content of each finished request and reply to a self-hosted ContextLedger service for administrators to browse.
- Upload large conversations in pieces: the plugin sends a fingerprint list first and then only the pieces the service does not have yet.
- Drop encrypted fields such as `encrypted_content`, and keep only the final streamed reply when it covers all stream fragments.
- Skip embedding requests (`format=embedding`); they are not sent to ContextLedger.
