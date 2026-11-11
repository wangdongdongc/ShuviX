---
shuvix: okf v0.2
type: Guide
title: 'Moving sessions into another project — how to split a project that grew too big'
description: 'Read this when the user wants to split a project, reorganise its sessions, or move a session into another project — an agent does it from a session of the destination project with the `session` tool; there is no button for it.'
tags: [shuvix, sessions, projects, move, split]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/main/services/sessionMove.ts
    title: sessionMove.ts — what can be moved and what happens afterwards
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/main/tools/session.ts
    title: session.ts — the `move-session` action
---

# Moving sessions into another project

A session belongs to one project (or to none). ShuviX has no button that moves a session to
another project and no sub-projects. A session is moved by an agent, and always **pulled**: the
agent of a session in the destination project brings other projects' sessions into its own project.
That is also how a project that grew too big is split.

## What the user does

1. Create the new project as usual. It may point at the same folder as the old project (a split by
   topic) or at another folder, such as a sub-folder (a split by module).
2. Open a session in the **new** project.
3. Type `@`, pick the sessions to bring over — the list covers every project — and ask the agent
   to move them here.
4. Approve the card. It lists every session of the request and where each comes from.

The moved sessions, with their sub-sessions, then appear under the new project.

## What the agent does

Call the `session` tool with action `move-session` and `session_ids`: the ids from the user's
mentions (`[session: id <id> — "<title>"]`), exactly as given. There is no destination parameter —
the destination is the project of the session making the call. So an agent cannot move a session
somewhere else, cannot move its own session, and a session that is not in a project cannot move
anything.

One call shows **one** card for all the sessions it names (at most 50). Only the user answers it,
and it cannot be remembered: a row that lets the agent read or talk to a session does not let it
move that session. Nothing in the sessions is read.

## What cannot be moved

| Session                                                         | Why                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| A sub-session                                                   | Move its parent; the sub-sessions come along                       |
| A bot session                                                   | It belongs to its bot, not to a project                            |
| A chat that is in no project, a browser-tab session             | Only a session of another project can be moved                     |
| The notebook of a knowledge entry, agent, bot, policy and so on | It is tied to that file                                            |
| A session in the middle of a turn, or with a running sub-session | It would change folder mid-turn; move it once the turn has ended   |
| A notebook whose file already has a notebook in this project    | One file has one notebook session                                  |

The result names each session that was not moved and the reason. A fork is a session of its own:
it stays unless it is named too.

## What changes for a moved session

- It works in this project from then on: this project's folder, environment variables, project
  prompt and project knowledge base. A variable the new project does not define is simply gone, so
  set the new project up first.
- What the session chose for itself stays: its MCP servers, its knowledge-base selection, and the
  paths and sessions granted in its permission table.
- When the two projects are in different folders, the session's system prompt is rebuilt, so its
  next message starts from this project. In the same folder nothing is rebuilt; if the project
  prompt or knowledge base differs, the session shows its usual notice that the system prompt is
  out of date and the user decides whether to rebuild.
- The conversation is untouched. Paths written in it still point where they pointed.

Knowledge-base entries are not moved by this: the entries of the old project stay in the old
project's knowledge base.
