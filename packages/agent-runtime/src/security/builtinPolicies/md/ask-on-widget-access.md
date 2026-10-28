---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-widget-access
shuvix-builtin: true
name: ask-on-widget-access
shuvix-displayName: Ask Before Using a Widget
description: The agent uses the widgets in this session's permission table freely; using any other widget asks you first.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [widget]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      !(object.widgetId in vars.aclWidgetRead)
    prompt: This lets the agent read the records you keep in this widget.
  - effect: ask
    action: [write]
    match: >-
      !(object.widgetId in vars.aclWidgetWrite)
    prompt: This lets the agent change the records in this widget, or change the widget itself, as you would in its own screen.
---

**What it does**: the agent uses your widgets through the `widget` tool. Each
widget has its own operations — the same ones its screen uses — and each one
either reads or changes the widget's records. The agent works freely with:

- **the widgets in this session's permission table** — "allow and remember"
  on a question card writes a row there. A row is either **read** (call the
  widget's read operations and preview it) or **read and write** (call every
  operation, and change the widget: build it, run SQL on its data, export it).
- **widgets this session created** — they start with a read-and-write row.

Anything else **asks**. A widget you allowed once asks again next time;
remember it to stop asking. The rows are in the session's settings under
Widget access, where you can switch a row between read and read-and-write or
remove it.

**Why it asks**: a widget keeps your own records — a reading list, expenses,
a log. Letting an agent use one lets it read or change them, and changing a
widget's code changes what every later call does.

**What it does not do**:

- The automatic review does not answer these questions: the builtin hook
  `auto-review` leaves widget access to you, so every card reaches you.
- Looking up which widgets exist and what their operations are never asks.
- Grants belong to one session. A sub-session starts with a copy of its
  parent's grants and a fork with a copy of its source's.

**To adjust**: create an override copy and edit it. Dropping the read rule
lets every session read every widget without asking.
