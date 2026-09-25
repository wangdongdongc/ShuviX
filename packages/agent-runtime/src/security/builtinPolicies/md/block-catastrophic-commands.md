---
shuvix: policy v1
shuvix-builtin: true
name: block-catastrophic-commands
shuvix-displayName: Block a Few Catastrophic Commands
description: A handful of ways to destroy a whole machine — deleting the root directory, formatting or overwriting a disk — are refused outright, on bash, PowerShell and ssh commands alike.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [command]
shuvix-policy-lets:
  blockDevices: "['/dev/sd', '/dev/nvme', '/dev/disk', '/dev/hd', '/dev/vd']"
  recursiveForce: "['--recursive', '--force']"
shuvix-policy-rules:
  # Recursive force-delete of the root directory
  - effect: deny
    action: [execute]
    match: >-
      object.commands.exists(c,
      c.base == 'rm'
      && (hasShortFlags(c.argv, 'rf') || hasShortFlags(c.argv, 'Rf')
      || recursiveForce.all(f, f in c.argv))
      && c.argv.exists(a, a == '/' || a == '/*'))
    prompt: Execution refused. The command parses as a recursive force-delete of the root directory.
  # Formatting or overwriting a block device — mkfs / dd / a redirect are three spellings of one thing
  - effect: deny
    action: [execute]
    match: >-
      object.commands.exists(c, c.base == 'mkfs' || c.base.startsWith('mkfs.'))
      || object.commands.exists(c, c.base == 'dd'
      && c.argv.exists(a, blockDevices.exists(d, a.startsWith('of=' + d))))
      || object.writes.exists(p, blockDevices.exists(d, p.startsWith(d)))
    prompt: Execution refused. The command parses as formatting or overwriting a block device.
  # Windows: drive-level format and secure wipe
  - effect: deny
    action: [execute]
    match: >-
      object.commands.exists(c,
      (c.base.lowerAscii() == 'format' && c.argv.exists(a, a.lowerAscii().matches('^[a-z]:')))
      || (c.base.lowerAscii() == 'cipher' && c.argv.exists(a, a.lowerAscii().startsWith('/w:'))))
    prompt: Execution refused. The command parses as a Windows drive-level format or secure wipe.
  # PowerShell: recursive delete of a drive root — Remove-Item under any of its names
  # (rm / del / rd …), any abbreviation of -Recurse, a literal root (C:\ / C:\* / \ / /)
  - effect: deny
    action: [execute]
    match: >-
      object.commands.exists(c,
      c.base.lowerAscii() == 'remove-item'
      && c.argv.exists(a, a.lowerAscii().matches('^-r(e(c(u(r(s(e)?)?)?)?)?)?$'))
      && c.argv.exists(a, a.matches('^([A-Za-z]:)?[\\\\/]\\*?$')))
    prompt: Execution refused. The command parses as a recursive delete of a drive root.
  # PowerShell: formatting a volume or wiping a disk
  - effect: deny
    action: [execute]
    match: >-
      object.commands.exists(c, c.base.lowerAscii() in ['format-volume', 'clear-disk'])
    prompt: Execution refused. The command parses as formatting a volume or wiping a disk.
---

**What it does**: a few ways of destroying a whole machine — deleting the root
directory, formatting or overwriting a disk — are refused before they run. Local
commands and ssh commands are treated the same, and the refusal holds even with
auto-allow on. On Windows that includes PowerShell's own spellings: deleting a drive
root with `Remove-Item -Recurse` under any of its names (`rm`, `del`, `rd` …),
`Format-Volume` and `Clear-Disk`.

The command is read as structure rather than as text, so writing the same thing
differently does not slip past: quoting inside the command name, wrapping it in
`bash -c`, or reaching the disk through a redirect instead of a tool all arrive
at the same place. PowerShell commands are read the same way — an alias, an
abbreviated parameter, curly quotes or an en dash in place of a hyphen, and a
`powershell -Command` / `-EncodedCommand`, `cmd /c` or `Invoke-Expression '…'`
wrapper do not change the verdict.

**What it does not do**:

- This is a short list, not a general danger check, and it is kept deliberately
  narrow. A rule that fires on ordinary work would be far worse than one that
  misses something, because a refusal cannot be waived for a single command.
- Anything whose target is only decided while the command runs — the output of
  `$(...)`, a command name assembled from a variable — is invisible to any check
  made beforehand. Those reach ask-on-command, which is the gate that actually
  puts every command in front of you.
- A script handed to a shell on its standard input rather than as an argument —
  `bash <<'EOF' … EOF`, `sh -s`, or a pipe into a shell — is not looked into.
  The `bash -c '…'` form is.
- PowerShell is read by ShuviX's own scanner, not by PowerShell itself. It follows
  the language's quoting and nesting, but a .NET call such as
  `[IO.Directory]::Delete(…)`, a script file, and anything assembled at run time
  are not looked into; neither is a root named by one command and deleted by the
  next (`Get-ChildItem C:\ | Remove-Item -Recurse`).
- Only what the command says is examined, not what it would end up touching.

**To adjust**: create an override copy and edit it — do so deliberately.
