---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-widget-access
shuvix-builtin: true
name: ask-on-widget-access
shuvix-displayName: 使用小组件前询问
description: 智能体可以自由使用本会话权限表里的小组件；用别的小组件，先问你。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [widget]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      !(object.widgetId in vars.aclWidgetRead)
    prompt: 这会让智能体读到你记在这个小组件里的记录。
  - effect: ask
    action: [write]
    match: >-
      !(object.widgetId in vars.aclWidgetWrite)
    prompt: 这会让智能体改这个小组件里的记录，或改这个小组件本身 —— 效果和你在它自己的界面里操作一样。
---

**它做什么**：智能体经 `widget` 工具使用你的小组件。每个小组件有自己的一组操作（就是它界面用的那一组），
每个操作要么读、要么改小组件里的记录。下面这些不问：

- **本会话权限表里的小组件** —— 询问卡片上「允许并记住」会在那里写一行。一行要么是**只读**（调小组件的读操作、
  预览它），要么是**读写**（所有操作都能调，也能改小组件：构建、对它的数据跑 SQL、导出）。
- **本会话自己建的小组件** —— 建成时就有一行读写。

其余的都**会问**。只允许一次的小组件下次还会问；记住它就不再问。这些行在会话设置的「小组件访问」里，
可以在只读和读写之间切换，也可以删掉。

**为什么问**：小组件里是你自己的记录 —— 读书清单、账目、日志。让智能体用一个小组件，它就能读或改这些记录；
改小组件的代码，会改变之后每一次调用做的事。

**它不做什么**：

- 自动审查不回答这类询问：内置 hook `auto-review` 把小组件访问留给你，每张卡片都会到你这里。
- 查有哪些小组件、各有哪些操作，从来不问。
- 授权只属于一条会话。子会话建成时复制父会话的授权，分支会话复制源会话的。

**怎么调整**：创建覆盖副本再改。去掉读的那条规则，所有会话读任何小组件都不再问。
