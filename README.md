# ShuviX

An AI agent that works where you work — with the tools and context to actually get things done, inside boundaries you control.

## Desktop app

A desktop AI assistant that connects to mainstream LLMs and acts on your computer on your behalf: reading and editing files, running commands, and reaching into your tools to carry out real tasks — all scoped to what you allow.

→ [`apps/desktop`](./apps/desktop/README.md)

## Chrome extension

ShuviX next to any page in your own Chrome. Each tab can open a side panel with its own conversation; the conversation runs in the desktop app, with your models, keys and policies, and can read and operate your signed-in tabs — asking before it touches a site you have not used in that conversation.

→ [`apps/extension`](./apps/extension/README.md)

## Scope

ShuviX is a **self-hosted, local-first** AI assistant. It runs on your own
machine and acts through tools you can inspect and allow, bringing your
choice of LLM to your files, terminal, and everyday tools. You own the
instance; the data lives on your machines — not ours.

### Non-goals

What ShuviX deliberately does **not** try to be:

- **A vendor-hosted cloud.** ShuviX is something you run, not a service we run
  for you. No multi-tenant backend, no "your data on our servers," no
  per-seat subscription. Self-hosting is the point.
- **A model provider.** Bring your own API keys. ShuviX won't bundle, host, or
  proxy models, and there's no paid inference tier.
- **A corporate teamwork suite.** Not real-time multiplayer editing, and not a
  Slack/Notion-style collaboration platform.
- **An enterprise product.** Not chasing the compliance, audit trails, and
  org-admin machinery that enterprise procurement demands.
- **A fully autonomous agent.** Human-in-the-loop is the point. System-touching
  actions pass through sandbox boundaries and ask you first.
- **An IDE.** It can read and edit code, but it won't grow into an editor with
  debugging, refactoring, and language servers. Use it alongside your editor.
- **A closed plugin ecosystem.** Extensibility rides on open standards — MCP and
  Skills. No proprietary marketplace.
