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
    match: object.browser == 'chrome' && object.scheme in ['http', 'https', 'blob'] && object.host != ''
    prompt: This is your own Chrome, signed in as you — the agent can see and act on this site with your accounts.
---

**What it does**: when an agent working from the ShuviX side panel in Chrome
wants to open a site, or to read or operate a tab showing a site, it asks you
first — once per site (host) per conversation. The sites of the tabs you send
with a message (the chips above the input; this tab by default) are already
allowed: sending a tab is asking about it. A tab the agent opened, or a page
that went on to another site by itself, is not.

**What it does not do**:

- It does not apply to the browser panel inside the ShuviX app. That browser
  keeps its own sign-ins, separate from your everyday browsing.
- It does not ask about pages that belong to no site — a blank tab, a `data:`
  page, Chrome's own `chrome://` pages. Local files go through the file
  policies instead.
- It does not remember across conversations. Each side panel conversation
  asks again.
- It does not look inside pages: once a site is allowed, what the agent does
  there in that conversation runs without asking.
- Once you turn the auto-allow switch on, another builtin policy —
  session-auto-allow — takes over and skips the ask.

**To adjust**: create an override copy and narrow the match. To stop asking
for a site you trust, exclude it, for example
`object.browser == 'chrome' && object.scheme in ['http', 'https', 'blob'] && object.host != '' && !(object.host in ['docs.example.com'])`.
