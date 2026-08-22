---
shuvix: policy v1
shuvix-builtin: true
name: session-auto-allow
shuvix-displayName: 会话免询问开关生效
description: 会话的免询问开关打开期间，所有询问一律跳过。
shuvix-policy-scope:
  subject.kind: [agent]
shuvix-policy-rules:
  - effect: consent
    match: vars.autoAllow
    prompt: 会话的免询问开关已打开，询问门被跳过。
---

**它做什么**：这就是会话配置面板里那个「免询问」开关。开着的时候，所有询问门 ——
文件读写、命令、git、数据库 —— 一律跳过，操作直接执行。

**它不做什么**：

- 压不过 deny。凭据保护与系统保护该拦还是拦，开不开免询问都一样。
- 只对本会话生效，不会带到新会话。

**想调整**：开关的语义就由这份策略给出。覆盖它就能收窄开关的范围 —— 比如让它开着
时写入仍然要问：

    shuvix-policy-scope:
      subject.kind: [agent]
    shuvix-policy-rules:
      - effect: consent
        action: [read, execute]
        match: vars.autoAllow

`subject.kind` 每条规则都必填（这里在 scope 里声明一次）。别漏 —— 非法的覆盖文件会被
整份跳过，而且**不会**遮蔽内置，于是一份「想收紧却没解析成功」的覆盖，留下的是原封不动
的完整开关。这是「非法用户文件永不遮蔽内置」这条兜底唯一与你意图相反的方向，所以改完
去策略页看一眼：如果生效的那份不是你写的，就是没解析过。
