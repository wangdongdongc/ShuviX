## What this document is

<!-- shuvix:agent-start -->
This document is an **agent profile** (`shuvix: agent v1`) in ShuviX's agents folder: the frontmatter decides the agent's tools, model and context (`shuvix-tools`, `shuvix-model`, `shuvix-instruction-files` …) and the body is that agent's entire system prompt. ShuviX reads it whenever it creates an agent from it, so a saved change reaches agents created afterwards; a running one keeps the version it started with. A file whose `name` matches a builtin profile (work, chat, coding, notebook …) replaces that builtin.

<!-- shuvix:manual-start -->
The full specification — every key, the placeholders, what makes the file invalid, examples — is the ShuviX manual entry `<<manual>>agent-md.md`. `read` it before changing something you are not sure of, instead of inferring the format from other files.
<!-- shuvix:manual-end -->
<!-- shuvix:agent-end -->

<!-- shuvix:bot-start -->
This document is a **bot file** (`shuvix: bot v2`): its body is the bot's persona and memory, part of the system prompt of every conversation with that bot, and the bot edits it itself to keep its memory. The frontmatter holds only `name`, `description` and `shuvix-displayName` — the bot's tools and model come from ShuviX, not from this file. A saved change reaches the bot's conversations at their next message; changing `name` moves those conversations to the new name.

<!-- shuvix:manual-start -->
The full specification is the ShuviX manual entry `<<manual>>bot-md.md`. `read` it before changing something you are not sure of, instead of inferring the format from other files.
<!-- shuvix:manual-end -->
<!-- shuvix:bot-end -->

<!-- shuvix:policy-start -->
This document is a **security policy** (`shuvix: policy v1`). ShuviX checks every agent operation — reading or writing a file, running a command, using another session or a widget — against all policies; one whose conditions match answers allow, ask or deny, and an `ask` goes to the automatic review and from there possibly to the user. An operation no policy matches is allowed. The file applies as soon as it is saved and parses, so a mistake can quietly drop a protection or block every operation of a kind. A file whose `name` matches a builtin policy replaces that builtin.

<!-- shuvix:manual-start -->
The full specification — the request document a rule sees, the condition keys, CEL `match`, effects and their precedence, what makes the file invalid, the builtin policies — is the ShuviX manual entry `<<manual>>policy-md.md`; rules for remote access (`subject.kind: network`) are in `<<manual>>network-policy.md`, and automatic redaction in `<<manual>>redaction.md`. `read` the entry before changing something you are not sure of, instead of inferring the format from other files.
<!-- shuvix:manual-end -->
<!-- shuvix:policy-end -->

<!-- shuvix:hook-start -->
This document is a **hook** (`shuvix: hook v1`): when a trigger point named in `shuvix-hook-on` fires and its CEL `when` holds, ShuviX runs the agent named in `shuvix-hook-agent` with this body as its task and the event attached. On an observe trigger it runs in the background and its answer is not used; on the decide trigger `permission.request` its answer settles an approval request. ShuviX reads the file at every trigger, so a saved change applies from the next one. A file whose `name` matches a builtin hook replaces that builtin.

<!-- shuvix:manual-start -->
The full specification — the keys, the trigger points and their events, `when`, the builtin hooks — is the ShuviX manual entry `<<manual>>hook-md.md`. `read` it before changing something you are not sure of, instead of inferring the format from other files.
<!-- shuvix:manual-end -->
<!-- shuvix:hook-end -->

<!-- shuvix:skill-start -->
This document is a **skill's `SKILL.md`** (the Agent Skills format Claude Code also uses). `name` is the skill's id — its on/off switch is keyed by it; `description` is all an agent sees before deciding to load the skill, and the body is what it reads once it does; the files beside `SKILL.md` are what the body points to. Every agent with the skill tool gets every enabled skill, and a saved change reaches agents created afterwards.

<!-- shuvix:manual-start -->
The full specification is the ShuviX manual entry `<<manual>>skills.md`. `read` it before changing something you are not sure of, instead of inferring the format from other files.
<!-- shuvix:manual-end -->
<!-- shuvix:skill-end -->

<!-- shuvix:knowledge-start -->
This document is a **note in a knowledge base**. Agents find notes with the `knowledge` tool's `search`, which matches title, description, tags and headings — not the body — so those are what make a note findable. An entry ShuviX has checked carries OKF frontmatter (`shuvix: okf v0.2`, `type`, `title`, `description`, `status`, `sources` …); `generated` and `verified` are stamped by ShuviX and never written by hand.

<!-- shuvix:manual-start -->
The full specification is the ShuviX manual entry `<<manual>>knowledge-entry.md`. `read` it before changing the frontmatter, instead of inferring the format from other notes.
<!-- shuvix:manual-end -->
<!-- shuvix:knowledge-end -->

<!-- shuvix:checked-start -->
ShuviX checks the file as you change it: each `doc_edit` / `doc_insert` result says whether it still parses, and `doc_read` says whether it does now. A file that does not parse is ignored until it is fixed; the user sees the same verdict on the document's property card.
<!-- shuvix:checked-end -->
