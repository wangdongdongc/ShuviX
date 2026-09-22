---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-new-site
shuvix-displayName: Ask Before Using a New Site in Chrome
description: In your own Chrome, the agent asks before it opens or works on a site it has not used in this conversation.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [url]
shuvix-policy-rules:
  - effect: ask
    action: [navigate]
    match: object.browser == 'chrome'
    prompt: This is your own Chrome, signed in as you — the agent can see and act on this site with your accounts.
---

**What it does**: when an agent working from the ShuviX side panel in Chrome
wants to open a site, or to read or operate a tab showing a site, it asks you
first — once per site (host) per conversation. The tab you opened the side
panel on is already allowed: asking about it is why you opened the panel.

**What it does not do**:

- It does not apply to the browser panel inside the ShuviX app. That browser
  keeps its own sign-ins, separate from your everyday browsing.
- It does not remember across conversations. Each side panel conversation
  asks again.
- It does not look inside pages: once a site is allowed, what the agent does
  there in that conversation runs without asking.
- Once you turn the auto-allow switch on, another builtin policy —
  session-auto-allow — takes over and skips the ask.

**To adjust**: create an override copy and narrow the match. To stop asking
for a site you trust, exclude it, for example
`object.browser == 'chrome' && !(object.host in ['docs.example.com'])`.
