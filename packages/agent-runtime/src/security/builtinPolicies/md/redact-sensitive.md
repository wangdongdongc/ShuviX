---
shuvix: policy v1
shuvix-id: policy:builtin:redact-sensitive
shuvix-builtin: true
name: redact-sensitive
shuvix-displayName: Keep Secrets Out of Model Requests
description: Secrets and personal data in new tool results and in messages a trigger or hook sends are stored and sent as placeholders; tools and the files they write keep the real values. It applies only to new content and never touches what a conversation already holds.
shuvix-policy-scope:
  subject.kind: [agent]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: allow
    action: [send]
    object.type: [modelRequest]
    disposition: detect
    prompt: New content for a model goes through redaction.
  - effect: allow
    action: [disclose]
    object.type: [sensitive]
    match: "!(object.category in ['USERNAME', 'HOSTNAME', 'IP', 'BUCKET'])"
    disposition: redact
    prompt: Secrets and personal data are stored and sent as placeholders.
---

**What it does**: before a tool result, or a message sent by a bot trigger or a hook, is written into a
conversation, ShuviX looks in it for secrets and personal data (API keys, tokens, private keys,
passwords, emails, phone numbers, ID and bank card numbers…) and stores each one as a placeholder such as
`{{REDACTED_API_KEY_k3v7x2mq}}`. The real value is kept, encrypted, in the session's own table. When a
tool runs, the placeholders in its arguments become the real values again, so commands work and files
get the real content. What the conversation stores is exactly what the model receives: nothing is
rewritten when a request goes out.

**Only new content**: this policy applies only to conversation content produced from now on, judged for
the model the conversation is using at that moment. **It never touches the conversation history**: sensitive
information already in a conversation's record stays there and keeps being sent as it is, and earlier
placeholders stay placeholders, whatever you change here and whichever model you switch to. To get rid of
something already sent, start a new session.

- **rule 1** (`modelRequest`, `send`): new content for every model is redacted (`detect`);
- **rule 2** (`sensitive`, `disclose`): each value found is stored as a placeholder (`redact`) — except
  four kinds that nearly every coding request contains and that the model must copy exactly: the user
  name in a home folder (`USERNAME`), `user@host` (`HOSTNAME`), public IP addresses (`IP`) and cloud
  buckets (`BUCKET`). Those are stored and sent as written.

Not checked: what you type in the input box (hide a value with + → Add a sensitive value), messages other
sessions send, the agent's own replies, instruction files and the system prompt.

**Objects**: `object.provider` is the provider's name as Settings shows it, `object.model` the model id. A
value found has `object.category` (the kinds above), `object.rule` (the detection rule) and `object.value`
(the value itself).

**Adjusting it** — write your own policy rather than editing this one:

- no redaction for a model (new content for it is stored as written, nothing is detected): `force-allow`
  on `action: [send]`, `object.type: [modelRequest]`, with `match: "object.provider == 'home-server'"`;
- let one kind through: `force-allow` on `action: [disclose]`, `object.type: [sensitive]`,
  `match: "object.category == 'EMAIL'"`;
- let a test key through: the same, with `match: "object.value.startsWith('sk-test-')"`;
- keep a kind as a placeholder even where another rule lets values through: `deny` with
  `match: "object.category == 'PRIVATE_KEY'"`;
- let only you answer when a command that uses a restored secret runs outside the sandbox
  (`ask-on-command` already asks; `force-ask` keeps the automatic review out of it): `force-ask` on
  `object.type: [command]` with `match: "size(tool.restored) > 0 && !object.sandboxed"`.

A `force-allow` without `disposition` wins over this policy's `allow` rules, so it turns redaction off for
what it matches. Disabling this policy turns auto-redaction off: new content is stored and sent with its
real values. Placeholders a conversation already holds stay, and tools can still restore them.
