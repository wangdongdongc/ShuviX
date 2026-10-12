---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-command
shuvix-builtin: true
name: ask-on-command
shuvix-displayName: Ask Before Running an Unconfined Command
description: A bash / PowerShell / ssh command that is not confined to the sandbox asks you per command — unless your classifier model rates it read-only with high confidence; confined commands run without asking.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [command]
shuvix-policy-rules:
  - effect: ask
    action: [execute]
    match: "(!has(object.sandboxed) || !object.sandboxed) && !(has(object.risk) && object.risk.category == 'read_only' && object.risk.readOnly >= 0.9)"
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

With a classifier model, a command from any of these that the classifier
rates plainly read-only runs without asking (see below).

Whether to ask is decided by the `sandboxed` attribute the host reports for
this run — and, if you picked a classifier model (Settings → General), by its
classification: a command the classifier puts in the `read_only` category with
a probability of at least 0.9 runs without asking and without the automatic
review (`object.risk.category` / `object.risk.readOnly`). Without a classifier
model, or when classifying fails, times out or comes back incomplete, there is
no `object.risk` and the command asks as before. The classifier only judges
what kind of action a command is — it cannot see a script's contents or what
you asked for — so anything that is not plainly read-only still asks. Every
classification is listed under Settings → Monitor → Classifier.

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
line makes every command ask again, confined or not; dropping the
`object.risk` part keeps every unconfined command asking even with a
classifier model, and raising or lowering 0.9 changes how sure it has to be.
