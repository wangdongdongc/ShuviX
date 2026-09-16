---
shuvix: policy v1
shuvix-builtin: true
name: protect-builtin-knowledge
shuvix-displayName: ShuviX 内置知识库保持只读
description: 智能体永远不能往 ShuviX 随应用发布的内置知识库里写。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: deny
    action: [write]
    match: inDir(object.path, [vars.builtinKnowledgeDir])
    prompt: >-
      写入已拒绝。这份文件属于 ShuviX 的内置知识库 —— 随应用发布的参考资料，每次更新整体替换。
      把你学到的东西记进用户自己的某个知识库（knowledge 工具的 "bases" 列出了它们）。
---

**它做什么**：任何落在 ShuviX 内置知识库目录下的文件写入一律拒绝 —— 开了免询问也一样。

**为什么**：那个库是 ShuviX 自己的说明书（agent / bot / policy / hook 文件、知识库条目与 skill
怎么写）。它在应用包里，每次更新整体替换，写进去的东西下个版本就没了 —— 在 macOS 上，被改过的
应用包还会对不上签名、可能拒绝启动。`knowledge` 工具已经拒绝在那里 `create` 并把它标成只读；
这条策略堵上剩下的那条路：拿工具印出来的绝对路径直接 `write` / `edit`。

**它不做什么**：

- 只拦智能体文件工具的写入；你放行的命令以你的完整系统权限运行，不受这里约束。
- 不拦读取 —— 读就是这个库的用途。
- 不覆盖你自己在 `~/.shuvix/knowledge/` 下的知识库 —— 那些见 ask-on-write。
