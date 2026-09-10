---
shuvix: policy v1
shuvix-builtin: true
name: review-knowledge-writes
shuvix-displayName: 知识库写入总要过目
description: 往知识库里写条目一律先询问，免询问开关打开时也照问 —— 会话摘要除外。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: force-ask
    action: [write]
    match: inDir(object.path, [vars.knowledgeRoot]) && !inDir(object.path, vars.knowledgeSessionDirs)
    prompt: 知识库条目写一次，之后同作用域的每个会话都会把它读回去。允许之前先确认这条值不值得留下。
---

**它做什么**：智能体要在知识库（`~/.shuvix/knowledge`）里新建或修改条目时，先询问你 ——
经 `knowledge` 工具还是直接写文件，落的是同一道门。与其它询问门不同，会话的「免询问」
开关打开时，这道门照样询问。

**它放过什么**：各个 `sessions/` 目录。会话摘要是宿主自动滚动维护的笔记，每次刷新都问
一遍，「自动」就变成一串弹窗了。它们仍是草稿，由你在知识库页面里审阅。

**它不做什么**：

- 只管文件工具与 `knowledge` 工具；你允许之后，智能体仍可以用命令写出一条条目。
- 不判断条目好不好 —— 那是你审阅的事。允许一次写入不等于核实：只有你在应用里标记
  之后，条目才算已核实。
- 不管读取。召回照旧自由。

**想调整**：建一份同名覆盖。把效果改成 `ask`，知识库写入就与普通写入一样（免询问打开时
跳过）；去掉 `sessions` 那一段，摘要也要过目；删掉规则，就不再询问。
