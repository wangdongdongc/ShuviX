# ShuviX

An AI agent that works where you work — with the tools and context to actually get things done, inside boundaries you control.

## Desktop app

A desktop AI assistant that connects to mainstream LLMs and acts on your computer on your behalf: reading and editing files, running commands, and reaching into your tools to carry out real tasks — all scoped to what you allow.

→ [`apps/desktop`](./apps/desktop/README.md)

## Chrome extension

ShuviX next to any page in your own Chrome. Each tab can open a side panel with its own conversation; the conversation runs in the desktop app, with your models, keys and policies, and can read and operate your signed-in tabs — asking before it touches a site you have not used in that conversation.

→ [`apps/extension`](./apps/extension/README.md)

## Run ShuviX on a Linux server (headless)

ShuviX can run on a machine without a screen — a Linux VM or a home server — and you use
it from a browser. In headless mode it opens no window and keeps network access on. By
default it only accepts connections from the machine itself (`127.0.0.1`), which you reach
from your own computer through an SSH tunnel; with `--lan` every device on the local
network can open it.

> **No password.** Whoever can open the address can fully control that computer through
> ShuviX: read and write files, run commands. With `--lan` that is anyone on the same
> network — only use it in a network you trust.

On Debian or Ubuntu (x86_64 or arm64), as a normal user with sudo rights, or as root on a
machine of its own such as an isolated VM (as root ShuviX runs with `--no-sandbox`, since
Electron does not start as root otherwise, so Chromium's process sandbox is off):

```sh
curl -fsSL https://github.com/wangdongdongc/ShuviX/releases/latest/download/install-linux.sh | bash -s -- --service
```

This installs the latest release's `.deb` with `apt-get` (which pulls in the libraries
Electron needs), adds a `shuvix-server` helper, and starts a systemd service `shuvix` that
runs ShuviX headless as you on port 7766. Then, from your own computer:

```sh
ssh -L 7766:127.0.0.1:7766 you@your-server
```

and open `http://127.0.0.1:7766/` in a browser there. Set up a provider (your API key)
under Settings, as on the desktop. To open it from other devices on the local network
without a tunnel, run the installer with `--service --lan` instead; it then prints the
addresses to open, for example `http://192.168.1.20:7766/`.

Options: `--version <tag>` installs a specific release (e.g. `v0.2.12-beta.1`),
`--port <n>` picks the port, `--lan` shares on the local network, `--bind <interface or
address>` shares on one network only (for a machine on several networks: ShuviX then listens
only on that interface's address and accepts only that subnet), `--uninstall` removes
the service and the app (your data in `~/.config/shuvix` and `~/.shuvix` stays),
`--dry-run` shows what would happen. Rerunning the script upgrades in place (and switches
between localhost-only and `--lan`). On other distributions it extracts the AppImage into
`~/.local/share/shuvix` instead (that build runs with `--no-sandbox`, since the extracted
app has no setuid sandbox helper).

- To update, run the same command without `--service`: the service keeps its port and
  network settings. When a new version is out, Settings → About shows the exact command.
- Without access to GitHub: download `install-linux.sh` and the `.deb` for your
  architecture from the release page on another machine, copy both to the server and run
  `bash install-linux.sh --deb shuvix-<version>-<arch>.deb --service` (add `--lan` /
  `--bind` as above; update the same way with the newer `.deb`, without `--service`). apt
  still installs the libraries Electron needs, so the server needs a package mirror — or
  copy those packages too: on a machine with the same distribution release and
  architecture that does not have them yet (a fresh container will do),
  `apt-get install --download-only ./shuvix-<version>-<arch>.deb` leaves them in
  `/var/cache/apt/archives/`; copy them over and install them first with
  `sudo apt-get install ./*.deb` in that folder, then run the script as above.
- Manage the service: `sudo systemctl status|restart|stop shuvix`; logs:
  `journalctl -u shuvix -f` (the line `ShuviX headless: ready — open one of: …` lists the
  addresses).
- Without systemd: `shuvix-server [--port <n>] [--lan | --bind <name>]` runs it in the foreground (Ctrl+C
  stops it).
- With `--lan`, allow the port in your firewall, e.g. `sudo ufw allow 7766/tcp`. Only
  private network addresses (10/8, 172.16/12, 192.168/16, link-local, loopback) are let in.
- On a desktop Mac or Linux machine, `shuvix --headless [--port <n>] [--lan | --bind <name>]`
  (or `SHUVIX_HEADLESS=1`, `SHUVIX_LAN=1`, `SHUVIX_BIND=<name>`) does the same without the installer;
  `shuvix --help` lists the flags. Headless and desktop ShuviX share the same data, so only
  one of them runs at a time.
- In headless mode the network access and local network switches in Settings are locked to
  the startup choice; stop the service to turn access off. The port and `--lan` come from
  the command line (the service file), not from Settings.
- On the desktop, Settings → General → Network access has the same two switches: access
  from a browser (this computer only) and, separately, other devices on the local network —
  with "Share on" to pick all networks or one network interface.
- Not available from a browser: markdown co-editing windows, the floating chat and the
  in-app browser window.

## Scope

ShuviX is a **self-hosted, local-first** AI assistant. It runs on your own
machine and acts through tools you can inspect and allow, bringing your
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
  actions pass through sandbox boundaries and ask you first.
- **An IDE.** It can read and edit code, but it won't grow into an editor with
  debugging, refactoring, and language servers. Use it alongside your editor.
- **A closed plugin ecosystem.** Extensibility rides on open standards — MCP and
  Skills. No proprietary marketplace.
