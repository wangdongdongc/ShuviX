---
shuvix: policy v1
shuvix-builtin: true
name: protect-shuvix-config
shuvix-displayName: 改动 ShuviX 自身配置之前必问
description: 写入 ShuviX 的策略、agent、hook 与技能一律询问你 —— 自动审查和免询问开关都不替你作答。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: force-ask
    action: [write]
    match: inDir(object.path, vars.shuvixConfigDirs)
    prompt: >-
      这次写入改的是 ShuviX 自己的配置 —— 一条安全策略、一个 agent 的指令、一个会自己运行的
      hook，或一个技能。它决定从此以后 agent 能做什么，自动审查本身也在其中。请看 diff。
---

**它做什么**：agent 用文件工具写入 `~/.shuvix/policies`、`~/.shuvix/agents`、`~/.shuvix/hooks`
或 `~/.shuvix/skills` 下的任何文件，都先问你，而且**开着免询问也照样问**。自动审查也不替你回答：
`force-ask` 只会交给你本人。

**为什么**：这些文件是规矩，不是内容。策略决定 agent 能做什么；agent 文件是系统提示词；hook 会
自己启动 agent；技能会被当作指令读取。自动审查本身也由它们构成 —— 审查员是一份 agent 文件，
触发它的是一份 hook 文件，而同名文件会覆盖内置的那一份。如果它们能在你看不到的时候被改掉，
一条被注入的指令就能把之后的所有检查永久关掉。

**它不做什么**：

- 它只管文件工具。命令在沙箱开着时由沙箱兜住（沙箱同样不让命令写 `~/.shuvix`）；不受沙箱约束的
  命令和其他命令一样被审查，而审查员把改动 ShuviX 的防护视为有害。
- 你自己在笔记本里的编辑不是 agent 的写入，永远不会被询问。你让笔记本里的 agent 改这些文件时，
  每一处改动都会问你 —— 这正是它的用意。
- bot 文件有自己的策略：protect-bot-files。

**如何调整**：创建一份覆盖副本再编辑 —— 请慎重。
