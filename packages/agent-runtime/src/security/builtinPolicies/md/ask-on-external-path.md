---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-external-path
shuvix-builtin: true
name: ask-on-external-path
shuvix-displayName: Ask Before Touching Files Outside This Session
description: The file tools work freely in this session's own directories; reading elsewhere in your home folder, or writing anywhere else, asks you first.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      inDir(object.path, vars.home)
      && !inDir(object.path, vars.sessionDirs)
      && !inDir(object.path, vars.sessionReadDirs)
      && !inDir(object.path, vars.grantedRead)
      && !inDir(object.path, vars.grantedWrite)
    prompt: This file is outside this session's directories. Reading it pulls it into the model context, where later turns and tool calls can carry it further.
  - effect: ask
    action: [write]
    match: >-
      !inDir(object.path, vars.sessionDirs)
      && !inDir(object.path, vars.grantedWrite)
    prompt: This writes outside this session's directories. Check the target path and the diff before allowing.
---

**What it does**: the file tools (read, write, edit, ls, grep, glob …) work
freely inside this session's own directories:

- the working directory — unless it is `/`, covers your whole home folder, or
  is ShuviX's own configuration or application data;
- this session's temporary folder (its commands' `$TMPDIR`), its artifacts
  (`~/.shuvix/artifacts/<session>/`) and its tool results (long outputs and
  background-task logs);
- the knowledge bases you ticked for this session — every change to a base is
  committed to its own git history, so it can be rolled back;
- the paths you answered "allow and remember" for — a write grant covers
  reading too.

Skill folders (the built-in ones and the ones you have enabled) and the
built-in ShuviX manual are **read-only** session directories: reading them is
free, changing them asks — a skill is instructions the agent itself follows.

Outside them, **reading a file in your home folder asks**, and **writing
anywhere asks**. Reading outside the home folder — system locations,
`/opt/homebrew`, `/Applications` — does not.

This is exactly the line the command sandbox draws: a confined command can
read and write the same session directories and read outside the home folder,
nothing else. Both take the lists from one place (`vars.sessionDirs` and
`vars.sessionReadDirs`, computed by the host from this session's settings — not
a list anyone maintains), so the agent gains nothing by switching from the file tools to
`cat` or `echo >`. Credentials such as `~/.ssh` are in your home folder, so
they are covered without a list of their own.

**What it does not do**:

- Commands are governed by ask-on-command and the sandbox. Without a sandbox
  (Windows, Linux, or the sandbox turned off) the same line still applies to
  the file tools, and every command asks.
- It does not always reach you: with the automatic review on, a reviewing
  agent answers first — it lets ordinary work through, refuses what is
  clearly harmful and puts the rest in front of you with its opinion.
- "Allow and remember" lasts for this session only; the remembered paths are
  listed in the session config panel, where you can remove them.

**To adjust**: create an override copy and edit it. Dropping the read rule
makes the file tools read anywhere without asking (the sandbox still keeps
confined commands out of your home folder).
