---
shuvix: policy v1
shuvix-builtin: true
name: block-catastrophic-commands
shuvix-displayName: 拦住几条毁机命令
description: 几种会毁掉整台机器的写法——删除根目录、格式化或整体覆写磁盘——在执行前直接拒绝，本地命令与 ssh 命令同等待遇。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [command]
shuvix-policy-lets:
  blockDevices: "['/dev/sd', '/dev/nvme', '/dev/disk', '/dev/hd', '/dev/vd']"
  recursiveForce: "['--recursive', '--force']"
shuvix-policy-rules:
  # 递归强删根目录
  - effect: deny
    action: [execute]
    match: >-
      object.commands.exists(c,
      c.base == 'rm'
      && (hasShortFlags(c.argv, 'rf') || hasShortFlags(c.argv, 'Rf')
      || recursiveForce.all(f, f in c.argv))
      && c.argv.exists(a, a == '/' || a == '/*'))
    prompt: 执行被拒绝。这条命令被解析为对根目录的递归强制删除。
  # 格式化或整体覆写块设备 —— mkfs / dd / 重定向是同一件事的三种写法
  - effect: deny
    action: [execute]
    match: >-
      object.commands.exists(c, c.base == 'mkfs' || c.base.startsWith('mkfs.'))
      || object.commands.exists(c, c.base == 'dd'
      && c.argv.exists(a, blockDevices.exists(d, a.startsWith('of=' + d))))
      || object.writes.exists(p, blockDevices.exists(d, p.startsWith(d)))
    prompt: 执行被拒绝。这条命令被解析为格式化或覆写块设备。
  # Windows：驱动器级格式化与安全擦除
  - effect: deny
    action: [execute]
    match: >-
      object.commands.exists(c,
      (c.base.lowerAscii() == 'format' && c.argv.exists(a, a.lowerAscii().matches('^[a-z]:')))
      || (c.base.lowerAscii() == 'cipher' && c.argv.exists(a, a.lowerAscii().startsWith('/w:'))))
    prompt: 执行被拒绝。这条命令被解析为 Windows 的整盘格式化或安全擦除。
---

**做什么**：几种会毁掉整台机器的写法——删除根目录、格式化或整体覆写磁盘——在执行前
被拒绝。本地命令与 ssh 命令同等待遇，即使开了免询问也压不过它。

命令是按结构读的，不是按文本读的，所以换个写法绕不过去：命令名里夹引号、外面包一层
`bash -c`、或者不用工具而是用重定向去写磁盘，最后都会落到同一处判定。

**不管什么**：

- 这是一份很短的清单，不是通用的危险检测，而且刻意收得很窄。一条会在正常工作上误触
  的规则，比一条漏掉某种写法的规则糟糕得多——拒绝是没法为单条命令网开一面的。
- 凡是要等命令跑起来才定下目标的写法——`$(...)` 的输出、由变量拼出来的命令名——事前
  的检查一概看不见。它们会走到 ask-on-command，那才是真正把每条命令摆到你面前的门。
- 通过标准输入而不是参数交给 shell 的脚本——`bash <<'EOF' … EOF`、`sh -s`、或者用管道
  喂给 shell——不会被读进去。写成 `bash -c '…'` 的那种会。
- 只看命令说了什么，不判断它最终会动到什么。

**怎么调**：创建覆盖副本后编辑——请谨慎行事。
