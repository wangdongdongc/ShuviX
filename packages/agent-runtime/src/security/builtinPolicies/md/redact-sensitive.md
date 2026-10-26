---
shuvix: policy v1
shuvix-id: policy:builtin:redact-sensitive
shuvix-builtin: true
name: redact-sensitive
shuvix-displayName: Keep Secrets Out of Model Requests
description: Secrets and personal data go to the model as placeholders; the agent's tools, the files they write and what you see keep the real values.
shuvix-policy-scope:
  subject.kind: [agent]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: allow
    action: [send]
    object.type: [modelRequest]
    disposition: detect
    prompt: Every request to a model goes through redaction.
  - effect: allow
    action: [disclose]
    object.type: [sensitive]
    match: "!(object.category in ['USERNAME', 'HOSTNAME', 'IP', 'BUCKET'])"
    disposition: redact
    prompt: Secrets and personal data go to the model as placeholders.
---

**What it does**: before anything is written to a conversation, ShuviX finds
secrets and personal data in it (API keys, tokens, private keys, passwords,
emails, phone numbers, ID and bank card numbers…) and stores a placeholder such
as `{{API_KEY_k3v7x2mq}}` instead. The real value is kept, encrypted, in the
session's own table. When a tool runs, the placeholders in its arguments become
the real values again, so commands work and files get the real content; the
screen shows a mark in their place. What the model receives is decided here:

- **rule 1** (`modelRequest`, `send`): every request to a model is subject to
  redaction (`detect`): ShuviX also looks for secrets the conversation does not
  hold yet (instruction files, the system prompt);
- **rule 2** (`sensitive`, `disclose`): each value found stays a placeholder
  (`redact`) — except four kinds that nearly every coding request contains and
  that the model must copy exactly: the user name in a home folder (`USERNAME`),
  `user@host` (`HOSTNAME`), public IP addresses (`IP`) and cloud buckets
  (`BUCKET`). Those are sent as written.

**Objects**: `object.provider` is the provider's name as Settings shows it,
`object.model` the model id. A value found has `object.category` (the kinds
above), `object.rule` (the detection rule) and `object.value` (the value itself).

**Adjusting it** — write your own policy rather than editing this one:

- trust a model (it gets real values, nothing is detected): `force-allow` on
  `action: [send]`, `object.type: [modelRequest]`, with
  `match: "object.provider == 'home-server'"`;
- let one kind through: `force-allow` on `action: [disclose]`,
  `object.type: [sensitive]`, `match: "object.category == 'EMAIL'"`;
- let a test key through: the same, with
  `match: "object.value.startsWith('sk-test-')"`;
- never send a kind (the whole request is held back): `deny` with
  `match: "object.category == 'PRIVATE_KEY'"`;
- let only you answer when a command that uses a restored secret runs outside the sandbox
  (`ask-on-command` already asks; `force-ask` keeps the automatic review out of it): `force-ask` on
  `object.type: [command]` with `match: "size(tool.restored) > 0 && !object.sandboxed"`.

A `force-allow` without `disposition` wins over this policy's `allow` rules, so
it turns redaction off for what it matches. Disabling this policy sends real
values to every model; conversations still store placeholders.
