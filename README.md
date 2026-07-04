# ShuviX

An AI agent that works where you work — with the tools and context to actually get things done, inside boundaries you control.

## Desktop app

A desktop AI assistant that connects to mainstream LLMs and acts on your computer on your behalf: reading and editing files, running commands, and reaching into your tools to carry out real tasks — all scoped to what you allow.

→ [`apps/desktop`](./apps/desktop/README.md)

## Browser extension

A browser-native AI assistant that lives in the side panel and works alongside whatever you're browsing, so its help stays in the flow of your work on the web.

→ [`apps/extension`](./apps/extension/README.md)

## Scope

ShuviX is a **self-hosted, local-first** AI assistant. It runs on your own
machine and acts through tools you can inspect and approve, bringing your
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
  actions pass through sandbox boundaries and approval gates.
- **An IDE.** It can read and edit code, but it won't grow into an editor with
  debugging, refactoring, and language servers. Use it alongside your editor.
- **A closed plugin ecosystem.** Extensibility rides on open standards — MCP,
  Skills, and Claude Code–style hooks. No proprietary marketplace.
