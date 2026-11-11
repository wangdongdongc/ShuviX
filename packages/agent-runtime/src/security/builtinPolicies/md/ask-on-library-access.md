---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-library-access
shuvix-builtin: true
name: ask-on-library-access
shuvix-displayName: Ask Before Reading Other Library Files
description: The agent reads the library files that belong to its session freely; reading any other file in the file library asks you first.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [library]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      !(has(object.linked) && object.linked)
    prompt: This lets the agent read a file from your file library that this conversation has not used.
---

**What it does**: notes and conversations point to files in the file library
with `shuvix://file/…` links, and the agent opens them with `read`. The agent
reads freely the library files that belong to its session:

- images you sent in this conversation;
- files you added to this session's note by pasting, dropping or inserting
  them.

A link merely written into a note does not count: the agent can write notes
too.

Reading any other library file **asks**.

**Why it asks**: the library holds the files of every note and conversation.
A link to one can turn up anywhere, in a note the agent reads, in a web page
or in a tool result, and following it should not quietly hand over a file
that belongs somewhere else.

**What it does not do**:

- The automatic review can answer these questions, as it does for reading a
  file outside the working directory.
- Showing library images to you in notes and conversations never asks; only
  the agent reading them does.

**To adjust**: create an override copy and edit it. Dropping the rule lets the
agent read every library file without asking.
