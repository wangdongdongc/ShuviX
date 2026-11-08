---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-settings
shuvix-builtin: true
name: ask-on-settings
shuvix-displayName: Ask Before the Agent Changes Settings
description: The agent can read the ShuviX settings that are open to it; changing one asks you first.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [channel]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [invoke]
    match: "object.access != 'read'"
    prompt: The agent wants to change your ShuviX settings. The card lists what changes; values you type on it go straight into your settings and the agent never sees them.
---

**What it does**: with the `shuvix` tool, the agent can work with ShuviX's own settings for
you, through the same settings API the app's settings pages use. For example, it can turn an
MCP setup snippet you paste into a server in your settings. Only settings that ShuviX has
opened to the agent are reachable. The tool's `describe` lists them. Reading needs no
approval. Every change asks you first, on a card that lists what will change. When the agent
leaves a secret empty (an API key, a token), the card has a masked field for it. What you type
there goes straight into your settings. It never reaches the conversation or the model.

**Who answers**: each call carries the same facts as a remote client's call:
`object.channel` (for example `mcp:add`), `object.scope` (which part of ShuviX, for example
`extensions`) and `object.access`.
- An `admin` change touches ShuviX's own configuration, such as MCP servers, and only you can
  answer it. The builtin hook `auto-review` leaves these to you.
- A `write` change can be answered by the automatic review.

**What it does not do**:

- It does not apply to remote clients. Their calls have `subject.kind: network` and follow your
  network access policies.
- Turning an added MCP server on in a session is a separate question, asked by
  `ask-on-extension`.

**To adjust**: to stop asking for one part, write your own policy scoped to
`subject.kind: [agent]` and `object.type: [channel]`, with a rule of `effect: force-allow`,
`action: [invoke]` and, for example, `match: object.scope == 'extensions'` (a plain `allow`
does not beat an `ask`). Values the agent left empty are still asked for, on a card that only
collects them.
