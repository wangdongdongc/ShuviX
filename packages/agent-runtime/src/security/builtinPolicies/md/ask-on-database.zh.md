---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-database
shuvix-displayName: 数据库SQL执行前询问
description: 具有写入权限的数据库连接上的每条SQL都逐条询问。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [database]
shuvix-policy-rules:
  - effect: ask
    action: [execute]
    match: '!object.readonly'
    prompt: 该连接具有写权限，这条 SQL 可能改动或删除服务端的数据。
---

**它做什么**：当智能体通过一个具有写权限的数据库连接执行 SQL 时，会逐条向你询问

**它不做什么**：

- 只读连接不拦：数据库自己会拒绝写入。
- 不分辨读还是写：本策略不会对 SQL 进行分析。
- 当你打开免询问的开关后，另一条内置的 session-auto-allow 策略将生效并跳过询问。

**想调整**：创建覆盖副本后编辑调整
