---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-settings
shuvix-builtin: true
name: ask-on-settings
shuvix-displayName: 智能体改设置前询问
description: 智能体可以查看开放给它的 ShuviX 设置；要修改，先问你。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [channel]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [invoke]
    match: "object.access != 'read'"
    prompt: 智能体要修改你的 ShuviX 设置。卡片上列出了要改什么；你在卡上填的值直接存进设置，智能体看不到。
---

**它做什么**：智能体可以用 `shuvix` 工具替你处理 ShuviX 自己的设置，走的是设置页用的同一套设置 API。
比如你贴一段 MCP 配置，它可以把这段配置加成设置里的一台服务器。只有 ShuviX 开放给智能体的那些设置它才够得着，
工具的 `describe` 会列出来。查看不用批准。每次修改都会先问你，卡片上逐行列出要改什么。智能体留空的秘密值
（API key、token）在卡上是打码输入框，你填的值直接存进设置，不会进对话，也不会到模型那里。

**谁来回答**：每次调用带的事实和远程客户端调用时一样：`object.channel`（比如 `mcp:add`）、
`object.scope`（管的是 ShuviX 的哪一块，比如 `extensions`）和 `object.access`。
- `admin` 级的修改动的是 ShuviX 自己的配置，比如 MCP 服务器，**只能由你回答**：内置 hook `auto-review` 把它们留给你。
- `write` 级的修改可以由自动审查代答。

**它不管什么**：

- 不管远程客户端：它们的调用是 `subject.kind: network`，按你的网络访问策略走。
- 加好的 MCP 服务器要在某条会话里开启，是另一个问题，由 `ask-on-extension` 来问。

**怎么调整**：想让某一块不再问，自己写一份范围是 `subject.kind: [agent]`、`object.type: [channel]` 的策略，
规则写 `effect: force-allow`、`action: [invoke]`，再加上比如 `match: object.scope == 'extensions'`
（普通的 `allow` 压不过 `ask`）。智能体留空的值照样要你填，只是换成一张只填值的卡片。
