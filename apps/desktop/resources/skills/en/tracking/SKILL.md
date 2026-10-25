---
name: tracking
description: "How to keep tracked items (one md per matter in `~/.shuvix/tracking/`): where to look, which matters to create directly, which only to suggest and which to leave alone, how to write progress, the file format, and how to reply when done. Load this before a scheduled pass over the tracked items, and when the user asks you to create or change one."
---

# Tracked items

A tracked item records something **the user considers unfinished** and wants to look at again in a few days: a bug not fixed yet, waiting on someone's reply, a decision not made yet. One md per matter, in `~/.shuvix/tracking/`; the user sees them under "Tracked items" in the sidebar's Library.

It is the user's list, not a summary of sessions. Most sessions are work that is done and need no tracked item; most passes create nothing new at all. Better to miss one than to keep more than the user wanted: the user will say what they want followed.

## Where to look

Only these three places. Do not look around elsewhere in `~/.shuvix`.

- **Sessions**: the `session` tool's `list-sessions`, with `active_since` set to the day of `lastFiredAt` in the trigger event (seven days ago when there is none). Skip the one marked `self="true"` (this run), and the ones with the same `bot` as that one whose `inputs` are only `trigger` — those are your earlier runs, not the user's activity. Look at the sessions that may matter with `read-session` or `inspect-session`.
- **Diary**: the `YYYY-MM-DD.md` files of this period in `~/.shuvix/daily/`, where the user wrote what they did that day. Fine if there are none.
- **The tracked items folder**: first `ls ~/.shuvix/tracking/` to see what is there, then read the items that matter this time. The folder may still be empty; create new files with `write`.

## What to do with each matter

- **An existing item**: when there is new progress in this period, update it (format below). No need to ask.
- **Create it directly**: only when **the user's own words** say it is not finished — in a session the user wrote "let's look at this later", "waiting for X to reply", "I'll continue tomorrow", "leave it for now", or the diary says "not fixed yet" and the like. An agent's summary, or an agent saying "a next step could be…", does not count. Quote those words in the progress when you create it.
- **Suggest it**: when there are no such words but you do think it is worth following, suggest it with the `suggest` tool, at most three per pass, the most useful first:
  - `title`: the matter, e.g. "Track: waiting on Li's reply about the migration";
  - `detail`: what it rests on — which session, what happened;
  - `message`: what the user says to you when they accept it, e.g. "Create a tracked item: waiting on Li's reply about the database migration". You receive that sentence when they accept; create the item then.
- **Leave it alone**: work that is done, a to-do that can be finished the same day, a topic that was only discussed, an idea the agent raised and the user did not take up.

## File format

Read `references/format.md` before writing or changing a tracked item: the frontmatter, the title, how to write the conclusion and the progress, and how to name the file.

- When the matter already has a file, update that one instead of creating another.
- Do not delete files unless the user asks.

## Replying when done

Say in a sentence or two which items were updated and which were created (with file names). The suggestions are already on cards; do not list them again in the reply. When nothing changed, say in one sentence that there was nothing to update.
