# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ShuviX is a desktop AI assistant built with Electron + React + TypeScript. It connects to mainstream LLMs via an agentic toolchain (file I/O, terminal, code search, SSH, etc.) with project sandboxing and optional Docker isolation. All data is stored locally in SQLite.

## Development Commands

```bash
npm install                  # Install dependencies (triggers electron-rebuild for better-sqlite3)
npm run dev                  # Start dev server (electron-vite dev with HMR)
npm run build                # Typecheck + build (electron-vite build)
npm run build:mac            # Build for macOS (dmg)
npm run build:win            # Build for Windows (nsis)
npm run build:linux          # Build for Linux (AppImage + deb)

npm run lint                 # ESLint with cache
npm run format               # Prettier format
npm run typecheck            # Typecheck both node and web targets
npm run typecheck:node       # Typecheck main/preload/shared only
npm run typecheck:web        # Typecheck renderer only

npm run test                 # Run all tests (vitest run)
npm run test:watch           # Watch mode
npx vitest run src/main/tools/__tests__/read.test.ts  # Run a single test file
```

## Architecture

### Electron Three-Process Model

The app uses `electron-vite` with three separate build targets:

- **Main process** (`src/main/`) — Node.js backend: database, agent orchestration, tool execution, IPC handlers
- **Preload** (`src/preload/index.ts`) — Bridge exposing `window.api` to renderer via `contextBridge`. All renderer→main communication goes through typed IPC channels defined here.
- **Renderer** (`src/renderer/`) — React UI with Tailwind CSS v4, Zustand stores

### TypeScript Configuration

- `tsconfig.node.json` — covers `src/main/`, `src/preload/`, `src/shared/`
- `tsconfig.web.json` — covers `src/renderer/`, references `src/main/types/` and `src/shared/`
- Path alias: `@renderer/*` → `src/renderer/src/*`

### Main Process Layers

```
src/main/
├── index.ts          # App entry: window creation, menu, lifecycle
├── ipc/              # IPC handler registration (one file per domain)
├── services/         # Business logic (agent, docker, ssh, mcp, providers, etc.)
├── dao/              # Data access layer (better-sqlite3, one DAO per table)
│   └── database.ts   # Singleton DB with WAL mode, migrations, seed data
├── tools/            # Agent tools (bash, read, write, edit, grep, glob, ls, ssh, ask, skill, etc.)
│   ├── types.ts      # ToolContext, ProjectConfig, sandbox guards
│   └── __tests__/    # Vitest tests (only main process code is tested)
├── utils/            # Path helpers, tool resolution
└── i18n.ts           # Main process i18n (i18next)
```

**Key service: `agent.ts`** — Wraps `@mariozechner/pi-agent-core` Agent. Each chat session gets its own Agent instance. The agent builds tools from builtin + MCP + Skill sources, handles streaming events, and forwards them to the renderer via IPC `agent:event`.

**Context management: `contextManager.ts`** — Three-tier progressive compression (toolResult truncation → thinking removal → sliding window) using tiktoken, applied via `transformContext` hook before each LLM call.

### Renderer Architecture

```
src/renderer/src/
├── App.tsx           # Entry: routes main window (Sidebar+ChatView) vs settings window (#settings hash)
├── stores/           # Zustand stores (chatStore, settingsStore)
├── hooks/            # Core lifecycle hooks:
│   ├── useAppInit      — App-level init (settings, providers, session list)
│   ├── useSessionInit  — Session-level init (messages, agent creation, metadata sync)
│   └── useAgentEvents  — Agent streaming event dispatcher
├── components/
│   ├── chat/         # ChatView, MessageBubble, ToolCallBlock, ModelPicker, etc.
│   ├── sidebar/      # Sidebar, ProjectCreateDialog, ProjectEditDialog
│   └── settings/     # SettingsPanel with tabs (General, Provider, Tool, MCP, Skill, HttpLog, About)
└── i18n.ts           # Renderer i18n (react-i18next)
```

### Shared Code

`src/shared/` — Constants and i18n locale files shared between main and renderer processes.

### Key Patterns

- **IPC communication**: All renderer→main calls use `ipcRenderer.invoke` / `ipcMain.handle`. The preload script (`src/preload/index.ts`) defines the full typed API surface under `window.api`.
- **Sandbox model**: Projects can enable sandbox mode — file tools enforce path boundaries via `assertSandboxRead`/`assertSandboxWrite` in `tools/types.ts`; bash commands require user approval.
- **Tool execution flow**: Agent calls tool → tool checks sandbox → executes (optionally in Docker container or via SSH) → result streamed back via IPC events.
- **Providers**: Built-in providers use `@mariozechner/pi-ai` SDK with env var injection for API keys. Custom providers use OpenAI-compatible API protocol via `providerCompat.ts`.
- **MCP integration**: External tool servers connected via `@modelcontextprotocol/sdk`, managed by `mcpService.ts`.
- **i18n**: Dual i18n setup — `i18next` for main process, `react-i18next` for renderer. Locale files in `src/shared/i18n/locales/`.

### Database

SQLite via `better-sqlite3` with WAL mode. Tables: `sessions`, `messages`, `settings`, `providers`, `provider_models`, `projects`, `http_logs`, `mcp_servers`, `skills`. Migrations are incremental column additions in `database.ts`.
