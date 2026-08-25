---
shuvix: policy v1
shuvix-builtin: true
name: review-memory-writes
shuvix-displayName: 记忆写入总要过目
description: 写入项目记忆一律先询问，免询问开关打开时也照问。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: force-ask
    action: [write]
    match: inDir(object.path, vars.memoryDirs)
    prompt: 记忆写一次，之后每个会话都会被读回去。允许之前先确认这条值不值得留下。
---

**它做什么**：智能体要新建或修改项目记忆时，先询问你。与其它询问门不同，
会话的「免询问」开关打开时，这道门照样询问。

**它不做什么**：

- 它只管文件工具；即使允许，智能体仍可以用命令写出一条记忆。
- 它不判断一条记忆写得好不好 —— 那正是需要你过目的原因。
- 它不管读取记忆，召回是自由的。

**想调整**：新建一份同名覆盖。把 effect 改成 `ask`，记忆写入就与普通写入一样
（免询问打开时跳过）；删掉这条规则则完全不再询问。
