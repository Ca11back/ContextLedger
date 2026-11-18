---
locale: en
translations:
  zh-CN: README.zh-CN.md
---
# ContextLedger

new-api logs who called which model and how many tokens they used, but not what was said. This plugin sends the content of each finished request and reply to your own [ContextLedger](https://github.com/Ca11back/ContextLedger) service, where administrators can browse and search it in a web page.

## Before you install

This plugin only sends data. You need a running ContextLedger service that new-api can reach, for example in the same Docker network. Follow the [deployment guide](https://github.com/Ca11back/ContextLedger/blob/main/deploy/README.md) first.

- Tested with new-api v1.0.0-rc.51.
- Use ContextLedger service 0.3.0 or later.
- It is not a channel type. It needs no vendor account or API key.

## Privacy

This plugin stores what your users write to the models and what the models answer, in full. That can include personal data, internal documents or keys that someone pasted into a prompt.

- The data goes only to the address you configure. Nothing is sent to the plugin author or any third party.
- Tell your users that their conversations are recorded, and follow the rules that apply to you.
- Limit who can sign in to ContextLedger, and use the request filter of the instance to skip groups or models you do not want recorded.

## Setup

1. Install the plugin.
2. Create a request processing instance for it and fill in three fields:
   - **Ingestion URL**: the service's ingest address, for example `http://contextledger:3000/api/ingest`.
   - **Ingestion token**: the `LEDGER_INGEST_TOKEN` you set on the service.
   - **Source identity**: the same value as `LEDGER_SOURCE` on the service.
3. Choose which requests the instance applies to, then enable it.

Clients do not change anything. After the next requests pass through the gateway, refresh the ContextLedger page to see them.

## What it saves

The plugin trims each record so that people can read it:

- Encrypted fields such as `encrypted_content` are dropped. Nobody can read or audit them.
- For streamed replies, only the final reply is kept when it provably contains everything the stream fragments said.
- Images are never sent. new-api already replaces them with placeholders like `[media:N]`.

It never sends the plugin configuration or request headers.

## How large conversations are sent

Long conversations repeat their whole history in every request. The plugin splits the content into small pieces and first sends only a list of their fingerprints. The service answers with the pieces it does not have yet, and the plugin uploads just those. The longer a conversation runs, the less each request has to upload.

## Limits

- new-api lets a plugin make at most 4 HTTP calls per request, each up to 1 MiB. So one request can upload about 3 MiB of new content. A larger new conversation is saved as "incomplete" and finished by its next requests. Incomplete records that nobody finishes within 1 hour are dropped.
- new-api passes at most about 1 MiB of each reply to plugins. The rest cannot be saved.
- When the gateway is busy or restarting, or the upload fails, some requests may not be saved.
- Content is uploaded over the URL you configure. Use a private network or HTTPS.

Embedding requests (`format=embedding`) are not sent to ContextLedger.
