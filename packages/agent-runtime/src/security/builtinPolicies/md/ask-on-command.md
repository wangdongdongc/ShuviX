---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-command
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
a command runs confined by default — it can read and write only this
session's own directories (the working directory, its temporary folder,
artifacts and tool results, plus the paths you allowed and remembered), read
system locations outside your home folder, and use the network — so it runs
without asking. What asks:

- a command the agent ran outside the sandbox (`dangerouslyDisableSandbox`).
  The sandbox is meant only for simple work inside the project; git,
  installing dependencies, builds and tools that read their config or caches
  in your home folder, docker, `open`, `sudo` … are expected to run outside
  it and come here;
- every command when the sandbox is off or not available on this computer
  (Windows and Linux today, or ShuviX itself running inside another sandbox);
- every ssh command — it runs on the remote machine, which no local sandbox
  reaches.

The ask is decided by the `sandboxed` attribute the host reports for this
run, never by what the command text looks like.

**What keeps a confined command confined**, besides the file boundary: it
cannot open apps, send Apple Events or schedule jobs (`open`, `osascript`,
`launchctl`), can signal only processes it started, and can connect only to
ShuviX's own command-line socket and DNS, not to other local services
(Docker, ssh-agent …). Without these one command could start something
outside the sandbox and the file boundary would be moot.

**What it does not do**:

- The ask is the gate: once you allow an unconfined command, it runs with
  your full system privileges.
- A confined command can still change anything in the working directory,
  including git's own files there.
- It does not always reach you: with the automatic review on, a reviewing
  agent answers first — it lets ordinary work through, refuses what is
  clearly harmful and puts the rest in front of you with its opinion.

**To adjust**: create an override copy and edit it. Dropping the `match`
line makes every command ask again, confined or not.
