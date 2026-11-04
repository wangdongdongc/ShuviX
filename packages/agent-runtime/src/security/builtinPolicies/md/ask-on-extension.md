---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-extension
shuvix-builtin: true
name: ask-on-extension
shuvix-displayName: Ask Before Enabling an Extension
description: The agent can look for an MCP server that is off in this session; turning one on asks you first.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [extension]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [enable]
    prompt: This turns on the extension for this session. The agent can then use all of its tools, and a server you added yourself may start its process now.
---

**What it does**: the servers ticked in a session are the ones whose tools the
agent has. When it needs something else, it can look through the servers that
are enabled in your settings but off in this session with `tool_search`, and
ask to turn one on. Every such request asks you. If you allow it, the whole
server is ticked for this session and the agent can call its tools from its
next step. Your widgets are servers here too: one server per widget, named
`widget-<id>`.

**Why it asks**: ticking a server is usually the only thing between the agent
and what that server can do. The built-in browser, for one, opens web pages
without asking and shares your signed-in sites, and `database` does not gate
SQL.

**What it does not do**:

- The automatic review does not answer these questions: the builtin hook
  `auto-review` leaves them to you, so every card reaches you.
- Searching never asks and never starts a server.
- A server already ticked in this session is not asked about, and neither is
  one you tick yourself.
- It does not apply to other sessions. A sub-session starts with a copy of its
  parent's selection and a fork with a copy of its source's.

**To adjust**: to stop asking for one server, write your own policy scoped to
`subject.kind: [agent]` and `object.type: [extension]`, with a rule of
`effect: force-allow`, `action: [enable]` and, for example,
`match: object.server == 'browser'` (a plain `allow` does not beat an `ask`).
Create an override copy of this policy and remove its rule to stop asking for
all of them.
