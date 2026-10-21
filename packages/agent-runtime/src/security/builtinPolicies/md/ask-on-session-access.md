---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-session-access
shuvix-builtin: true
name: ask-on-session-access
shuvix-displayName: Ask Before Using Another Session
description: The agent works freely with its own sub-sessions and with the sessions in this session's permission table; reading or talking to any other session asks you first.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [session]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      !object.ownTurn
      && !(object.sessionId in vars.aclSessionRead)
    prompt: This brings another session's conversation — its answers and what it did — into this one. That session may belong to another project.
  - effect: ask
    action: [write]
    match: >-
      !object.ownTurn
      && !(object.sessionId in vars.aclSessionWrite)
    prompt: This sends a message into another session, which then works with its own folder and its own permission table. Check the message before allowing.
---

**What it does**: the agent can work with other sessions through the `session`
tool — you @-mention a session in the composer, and the agent addresses it by
its id. It works freely with:

- **its own sub-sessions** — the ones it opened itself;
- **the turn it started** in another session: collecting that turn's answer,
  answering a question that turn asks, steering it, stopping it — starting the
  turn already went through this policy;
- **the sessions in this session's permission table** — "allow and remember"
  on a question card writes a row there. A row is either **read** (read its
  answers, look at what happened in it, wait for it) or **talk** (send it a
  message, steer it, answer its questions, stop a turn you started — talking
  includes reading).

Anything else **asks**: reading another session, and every message sent into
one. A session you allowed once asks again next time; remember it to stop
asking. The rows are in the session's settings, where you can switch a row
between read and talk or remove it.

**Why it asks**: another session has its own working folder and its own
permission table — often another project. Letting an agent talk to it lets
that agent reach whatever that session may reach, and reading it moves its
conversation into this one.

**What it does not do**:

- The automatic review does not answer these questions: the builtin hook
  `auto-review` leaves session access to you, so every card reaches you.
- It does not limit what the other session does once it has a message — its
  own policies and permission table govern that, as for any message you type
  there.
- Grants belong to one session. A sub-session starts with a copy of its
  parent's grants and a fork with a copy of its source's.

**To adjust**: create an override copy and edit it. Dropping the read rule
lets the agent read any session it knows the id of without asking.
