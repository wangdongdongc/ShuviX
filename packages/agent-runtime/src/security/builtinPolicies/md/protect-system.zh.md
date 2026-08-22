---
shuvix: policy v1
shuvix-builtin: true
name: protect-system
shuvix-displayName: 保护部分系统目录
description: 智能体永远不能写入操作系统位置。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-lets:
  systemDirs: >-
    ['/etc', '/usr', '/bin', '/sbin', '/boot', '/proc', '/sys', '/root',
    '/System', '/Library', '/private/etc', '/private/var'] + vars.systemDirs
shuvix-policy-rules:
  - effect: deny
    action: [write]
    match: inDir(object.path, systemDirs)
    prompt: 写入被拒绝。这是操作系统目录，对智能体关闭。
---

**它做什么**：智能体永远不能写入操作系统位置（`/etc`、`/usr`、`/System`、
Windows 的系统与程序目录……）—— 开了免询问也不行。

**它不做什么**：

- 只拦智能体文件工具的写入；你允许过的命令以完整系统权限运行，不受此约束。
- 不拦这些位置的读取。
- 不覆盖你自己的文件 —— 那些由 ask-on-read / ask-on-write 负责。

**想调整**：创建覆盖副本后编辑调整 —— 请慎重。
