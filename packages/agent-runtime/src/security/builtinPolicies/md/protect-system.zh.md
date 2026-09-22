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
  tempDirs: >-
    ['/private/var/folders', '/private/var/tmp']
shuvix-policy-rules:
  - effect: deny
    action: [write]
    match: inDir(object.path, systemDirs) && !inDir(object.path, tempDirs)
    prompt: 写入被拒绝。这是操作系统目录，对智能体关闭。
---

**它做什么**：智能体永远不能写入操作系统位置（`/etc`、`/usr`、`/System`、
Windows 的系统与程序目录……）—— 开了免询问也不行。

路径按它真正通向的位置算，而不是按写法：项目里一条指向 `/etc` 的链接与 `/etc`
本身同样被拒；在 macOS 上 `/var/…` 就是 `/private/var/…`。

**它不做什么**：

- 只拦智能体文件工具的写入；你允许过的命令以完整系统权限运行，不受此约束。
- 不拦这些位置的读取。
- 临时目录不算系统位置，哪怕 macOS 把它们放在 `/private/var` 下：你自己的临时目录
  （`$TMPDIR`，在 `/private/var/folders` 下）与 `/private/var/tmp` 照常可写（照常询问）。
- 不覆盖你自己的文件 —— 那些由 ask-on-read / ask-on-write 负责。

**想调整**：创建覆盖副本后编辑调整 —— 请慎重。
