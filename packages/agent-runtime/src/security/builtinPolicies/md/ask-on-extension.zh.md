---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-extension
shuvix-builtin: true
name: ask-on-extension
shuvix-displayName: 开启扩展前询问
description: 智能体可以查找这条会话没开启的 MCP 服务器；要开启，先问你。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [extension]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [enable]
    prompt: 这会为这条会话开启这个扩展。智能体之后能用它的全部工具；如果是你自己添加的服务器，现在可能会启动它的进程。
---

**它做什么**：一条会话里勾选了哪些服务器，智能体就有哪些工具。需要别的能力时，它可以用 `tool_search` 在设置里已启用、
但这条会话没开启的服务器中查找，并申请开启其中一台。每次申请都会问你。你允许后，整台服务器就在这条会话里勾上了，
智能体从下一步起就能调用它的工具。

**为什么问**：勾选往往是智能体和这台服务器的能力之间唯一的一道门。比如内置浏览器打开网页不询问，还共用你已登录的网站；
`database` 也不拦 SQL。

**它不做什么**：

- 自动审查不回答这类询问：内置 hook `auto-review` 把它们留给你，每张卡片都会到你这里。
- 搜索本身从不询问，也不会启动任何服务器。
- 这条会话已经勾选的服务器不问，你自己勾选的也不问。
- 不影响别的会话。子会话建成时复制父会话的选择，分支会话复制源会话的。

**怎么调整**：想对某一台不再询问，写一条自己的策略，范围是 `subject.kind: [agent]` 和 `object.type: [extension]`，规则写
`effect: force-allow`、`action: [enable]`，再加上比如 `match: object.server == 'browser'`（普通的 `allow` 压不过 `ask`）。想全都不再询问，创建这条策略的覆盖副本并去掉规则。
