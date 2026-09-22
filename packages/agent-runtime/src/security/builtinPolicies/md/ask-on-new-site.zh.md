---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-new-site
shuvix-displayName: 在 Chrome 中使用新站点前询问
description: 在你自己的 Chrome 里，智能体打开或操作本次对话没用过的站点之前，先询问你。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [url]
shuvix-policy-rules:
  - effect: ask
    action: [navigate]
    match: object.browser == 'chrome' && object.scheme in ['http', 'https', 'blob']
    prompt: 这是你自己的 Chrome，登录着你的账号 —— 智能体能以你的身份看到并操作这个站点。
---

**它做什么**：在 Chrome 里通过 ShuviX 侧边栏工作的智能体，要打开一个站点、或者读取 / 操作显示某个站点的
标签页之前，先询问你 —— 每个站点（host）在每次对话里只问一次。你随消息带上的标签页（输入框上方那排
芯片，缺省就是本标签页）所在的站点已经算允许：带上它，本来就是要问它。智能体自己打开的标签页、
页面自己跳去的别的站点，不在此列。

**它不做什么**：

- 不管 ShuviX 应用内的浏览器面板：那个浏览器有自己的登录态，与你日常用的浏览器隔离。
- 不管不属于任何站点的页面 —— 空白页、`data:` 页面、Chrome 自己的 `chrome://` 页面。本地文件另由
  文件相关的策略把关。
- 不跨对话记住：每一次侧边栏对话都会重新询问。
- 不看页面里的内容：一个站点放行之后，智能体在本次对话里在这个站点上的操作不再询问。
- 当你打开免询问的开关后，另一条内置的 session-auto-allow 策略将生效并跳过询问。

**想调整**：创建覆盖副本后收窄匹配条件。想让某个信任的站点不再询问，就把它排除在外，例如
`object.browser == 'chrome' && object.scheme in ['http', 'https', 'blob'] && !(object.host in ['docs.example.com'])`。
