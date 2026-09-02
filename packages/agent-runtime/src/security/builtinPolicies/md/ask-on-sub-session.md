---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-sub-session
shuvix-displayName: Ask Before Opening a Sub-session
description: Opening a sub-session asks you first — it is a new conversation that spends tokens on its own.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [invocation]
shuvix-policy-rules:
  - effect: ask
    action: [execute]
    match: "tool.name == 'session' && tool.operation == 'create-sub-session'"
    prompt: This starts a new conversation that runs on its own and spends tokens without asking again.
---

**What it does**: when the agent wants to open a sub-session, it asks you first.

A sub-session is not one tool call — it is a whole conversation the agent can
drive on its own, with its own model, its own tools and no further prompt to
you. That is worth one decision from you up front.

**What it does not do**:

- It does not gate the messages the agent later sends into a sub-session it
  already opened, nor waiting for or reading their answers. Those follow from
  the decision you already made here.
- It does not gate what the sub-session then does: every tool call inside it is
  evaluated against these same policies, in that session, as usual.
- Once you turn the auto-allow switch on, another builtin policy —
  session-auto-allow — takes over and skips the ask.

**To adjust**: create an override copy and edit it. Removing the rules makes
sub-sessions open without asking.
