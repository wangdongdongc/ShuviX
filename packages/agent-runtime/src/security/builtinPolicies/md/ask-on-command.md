---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-command
shuvix-displayName: Ask Before Running an Unconfined Command
description: A bash / PowerShell / ssh command that is not confined to the sandbox asks you per command; confined commands run without asking.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [command]
shuvix-policy-rules:
  - effect: ask
    action: [execute]
    match: '!has(object.sandboxed) || !object.sandboxed'
    prompt: This command is not confined — once allowed it runs with your full system privileges, any file, any network access. Read what it actually does before allowing.
---

**What it does**: a command that would run with your full privileges has to
ask you first. On macOS, with the sandbox on (Settings → LLM tools → bash),
ordinary commands are confined — they can change files only where
ask-on-write would not ask anyway (the project, temporary folders, tool
caches), cannot touch what protect-credentials lists, and cannot step
outside the sandbox — so they run without asking. What still asks:

- a command the agent explicitly asked to run with full access, because it
  cannot work confined (opening apps, `osascript`, docker, `sudo`, creating a
  git repository, pushing to a private remote …);
- every command when the sandbox is off or not available on this computer
  (Windows and Linux today, or ShuviX itself running inside another sandbox);
- every ssh command — it runs on the remote machine, which no local sandbox
  reaches.

The ask is decided by the `sandboxed` attribute the host reports for this
run, never by what the command text looks like.

**What keeps a confined command confined** — the sandbox's own fence. Without
it one command could set up something that runs later outside the sandbox,
and every other check here would be moot:

- it cannot write git's own metadata (`.git/hooks`, `.git/config` …) — git,
  and every editor that runs `git status` in the background, would execute it;
- it cannot write ShuviX's own files (`~/.shuvix` apart from knowledge bases,
  widgets and artifacts, and ShuviX's application data) — they hold these
  policies, the sandbox switch and the launcher Chrome runs for the extension;
- it can connect only to ShuviX's own command-line socket and DNS, not to
  other local services (Docker, ssh-agent …);
- it cannot open apps, run AppleScript or schedule jobs (`open`,
  `osascript`, `launchctl`), and can signal only processes it started;
- a working directory or write grant that covers your home folder is not
  sandboxed at all — every command there asks.

Everything else is open on purpose: a confined command can read any file
outside the credential list and use the network.

**What it does not do**:

- The ask is the gate: once you allow an unconfined command, it runs with
  your full system privileges.
- A confined command can still change anything inside the project — deleting
  the project is inside the sandbox. block-catastrophic-commands still refuses
  its short list of machine-destroying commands either way.
- It does not always reach you: with the automatic review on, a reviewing
  agent answers first — it lets ordinary work through, refuses what is
  clearly harmful and puts the rest in front of you with its opinion.
- Once you turn the auto-allow switch on, another builtin policy —
  session-grants — takes over and skips the ask, full-access requests
  included.

**To adjust**: create an override copy and edit it. Dropping the `match`
line makes every command ask again, confined or not.
