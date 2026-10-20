---
shuvix: okf v0.2
type: Guide
title: 'Remote access policy — who can connect and what each device may do'
description: 'How to write security policies for ShuviX remote access: the network subject and every fact a request carries, the four check points (socket, request, channel, path), `inCidr`, why `ask` refuses, the builtin `network-admission` and how to replace it, recipes for common setups, checking a draft with `shuvix policy check` before installing it, and what a policy cannot do (no authentication, device IDs, SSH tunnels, agents as a way around).'
tags: [shuvix, policy, security, network, remote-access]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/main/frontend/network/policyGate.ts
    title: policyGate.ts — the check points and the facts they report
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/builtinPolicies/md/network-admission.md
    title: network-admission.md — the builtin admission policy
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/shared/channelAccess.ts
    title: channelAccess.ts — the access tag of every channel
---

# Remote access policy

**Remote access** (Settings → General → Network access, or `shuvix --headless`) lets a browser
use ShuviX over the network — with everything ShuviX can do on this computer, and **without a
password**. ShuviX itself only makes three fixed checks: the sender must be on a private network
(or this computer), the `Host` header must be an IP address or `localhost` with ShuviX's port,
and a WebSocket must come from the page ShuviX served. **Everything else is security policy**,
written in the same policy files as the gates on agents (the `policy-md` entry has the full
format). There is no other access control, and no policy means no restriction.

ShuviX ships one network policy, `network-admission`: **only this computer can connect**. To let
other devices in, replace it.

## Working with the user

When the user asks you to set up remote access:

1. Ask, in one round, what you need: which devices will connect (phone, laptop, a whole network?)
   and how — the same local network, an SSH tunnel, a VPN; what each of them needs to do — only
   look, talk to agents, change settings; and how to recognise each device — by its address, by
   its network, or by its device ID (below). Do not guess addresses.
2. Write the policy as a **draft in your working directory** first, named as it will be
   installed — `network-admission.md` (the **same name** replaces the builtin; a `deny` beats
   every allow, so a second policy cannot loosen it). Put further restrictions in the same file
   or in other policies. Do not write straight into `~/.shuvix/policies/`: a policy there takes
   effect within seconds, and a wrong admission policy cuts off the device the user may be
   talking to you from. The `write` result says whether the file parsed and lists the parser's
   warnings.
3. **Check the draft** with `shuvix policy check network-admission.md` (bash). It decides as if
   the draft were installed and prints a table — this computer, the connected and recently
   refused devices, an outside address × page / read / write / admin — with the rule that
   refused each cell. Compare **every row** with what the user asked for. For what the table does
   not show (a device not seen yet, a specific channel, a file path), check single requests:
   `shuvix policy check network-admission.md --from 192.168.1.23 --channel session:prompt --expect allow`
   (`--device <id>` for device rules; `--page`, `--read`, `--write`). Fix the **rule** until
   every row and every expectation matches; this computer must stay `allow`. `shuvix policy check
   --help` lists every option.
4. Install it: write the same content to `~/.shuvix/policies/network-admission.md` (and any
   further policy files next to it), then run `shuvix policy check` once more without a file to
   confirm what is now in effect.
5. Explain each rule in plain words, say what it does **not** protect against (see the last
   sections), and tell the user how to check it (Verify, below).

Never write a password or token into a policy, and never claim the result is "secure": it is
access control without authentication.

## The request document

Every network check is a request whose `subject.kind` is `network`. Next to the fixed subject
fields, a network subject carries these attributes — **all of them in every check**, empty when
not known yet (a socket check has no headers yet):

| `subject.` attribute | Type   | Meaning                                                                                     | Trustworthy                                  |
| -------------------- | ------ | ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `address`            | string | the sender's IP address (an IPv4-mapped IPv6 address is written as IPv4)                    | yes — from the TCP connection                |
| `port`               | int    | the sender's port                                                                           | yes                                          |
| `localAddress`       | string | the address of this computer the connection came in on                                      | yes                                          |
| `localPort`          | int    | ShuviX's port                                                                               | yes                                          |
| `family`             | string | `ipv4` or `ipv6`                                                                            | yes                                          |
| `interface`          | string | the network interface `localAddress` belongs to (`en0`, `eth1`); `''` when unknown          | yes                                          |
| `headers`            | map    | every request header, lower-case names; repeated headers joined with `, `; `{}` before HTTP | **no** — the browser (or anyone) writes them |
| `cookies`            | map    | the request's cookies                                                                       | **no**                                       |
| `device`             | string | the browser's device ID (below); `''` when the browser has none yet                         | **no** — see Device IDs                      |
| `userAgent`          | string | the `User-Agent` header                                                                     | **no**                                       |
| `connection`         | string | the WebSocket connection (`ws:7`) for channel and file-channel checks; `''` otherwise       | yes                                          |

`env.host` is `desktop` (also when headless). `vars` has the host variables of the `policy-md`
entry that do not belong to a session — `home`, `shuvixConfigDirs`, `botsDir`, `skillsDirs` … —
and no session permission table (`aclRead` / `aclWrite`).

### The four check points

| When                                                | `object.type` | `action`         | Object attributes                                                                                     | When refused                                        |
| --------------------------------------------------- | ------------- | ---------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| a TCP connection opens, before HTTP is read         | `socket`      | `connect`        | none                                                                                                  | the connection is closed without a reply            |
| every HTTP request, including the WebSocket upgrade | `request`     | `request`        | `method`, `path` (URL path), `query` (map, first value per name), `route` (below)                     | HTTP 403 with the rule's `prompt` and the device ID |
| every call over the WebSocket                       | `channel`     | `invoke`         | `channel` (`session:list`), `group` (`session`), `kind` (`invoke` / `send`), `access`, `size`, `args` | the call fails with code `denied` and the `prompt`  |
| a file the network reads or writes                  | `path`        | `read` / `write` | `path` (where it really leads), `requestedPath`, `displayPath`; `tool.name` / `tool.operation` below  | 403, or the file is not shown / not saved           |

`route` is `page` (`/`), `asset` (the page's scripts and styles), `media`, `preview`,
`download` (file routes), `lib` (chart libraries), `widget` (`/w/…`) or `socket` (the `/ws`
upgrade every page makes). The `path` check runs for the file routes (`tool.name` `files`,
`tool.operation` `media` / `preview` / `download`) and for the channels that read or write a
file anywhere on disk: `files:read` / `files:write` (`files`, `read` / `write`) and
`fs:listDirectories` (`fs`, `listDirectories`). ShuviX itself does not limit those paths.

**`access`** sorts every channel into one of three: `read` (reads data, no secrets), `write`
(changes the user's data or makes something happen — sending a message to an agent, deleting a
session, writing a file, using the terminal) and `admin` (changes ShuviX itself — policies,
hooks, agents, settings, providers, network access, updates — or returns secrets such as API
keys). The `network-channels` entry lists every channel with its tag. `args` is the call's
arguments as sent (a list); reading it ties a rule to ShuviX's internal API, which changes
between versions — prefer `channel`, `group` and `access`.

## Effects on network checks

Nobody can be asked at a network check. The engine settles a request exactly as for agents
(deny > force-ask > force-allow > ask > allow; no rule = allow) and then treats an `ask` or
`force-ask` result as **refused**. Write `deny` — the parser warns about an `ask` rule whose
`subject.kind` is only `network`. A `force-allow` still beats an `ask`, as everywhere.

A rule whose `match` fails to evaluate counts as matched for `deny` (fail-safe), so a sloppy
expression refuses everything. The usual cause is a missing key: `subject.headers['x-real-ip']`
errors when the request has no such header — write `'x-real-ip' in subject.headers && …`.
`has()` does not work after an index (`has(object.args[0].x)` is an error).

## Writing rules that evaluate

A `deny` whose `match` fails to evaluate refuses **every** request of its kind — this computer
included. Three habits keep that from happening:

- **Put this computer first, joined with `&&`:** `!inCidr(subject.address, ['127.0.0.0/8', '::1']) && …`.
  For this computer the left side is false, so the rest is never evaluated, mistakes included.
- **`lets` see only `vars`.** A let that reads `subject`, `object`, `action`, `tool` or `env` makes
  the file invalid. Constants (`phone: "'Xq3…'"`, a list of networks) belong in `lets`; anything about
  the request belongs in the rule's `match`.
- **Read the `write` result.** For each rule on the `network` subject the parser tries the `match`
  on a sample request of every kind the rule covers; "the match fails on a sample … request" means
  that rule would refuse everything it covers. Fix it before you finish.

## `inCidr(ip, cidrs)`

True when `ip` is in any of `cidrs` — a string or a list of `a.b.c.d/n`, `x::/n` or a single
address. An IPv4-mapped IPv6 address counts as IPv4; an entry that is not a valid network never
matches, and neither does an `ip` that is not an address.

```
inCidr(subject.address, ['127.0.0.0/8', '::1'])                  # this computer
inCidr(subject.address, ['192.168.1.0/24', '10.8.0.0/16'])       # two networks
inCidr(subject.address, '192.168.1.23')                          # one address
```

## The builtin `network-admission`

```yaml
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    action: [request]
    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1'])"
```

Every HTTP request from another device is refused with a page that tells the person what to do;
an SSH tunnel arrives as `127.0.0.1` and gets in. Replace it with a user file of the same
`name` (the sidebar's "Create override copy" writes the current text as a starting point). A
replacement that fails to parse does not replace anything — the builtin keeps refusing — and is
listed in amber in the sidebar's Security Policies. Disabling the builtin instead of replacing
it lets every device on the local network in. Settings → General → Network access shows which
one is in effect.

## Recipes

Each block is the frontmatter of `~/.shuvix/policies/network-admission.md` (plus `shuvix:
policy v1` and `name: network-admission`). Always keep this computer in (`127.0.0.0/8`, `::1`).

**One or more networks:**

```yaml
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    action: [request]
    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1', '192.168.1.0/24', '10.8.0.0/16'])"
    prompt: Only this computer and devices on the home and VPN networks can connect.
```

**Particular devices.** A browser's first visit gets a device ID even when it is refused, and
the refusal page shows it (`Device: …`); Settings → Network access lists the IDs of connected and
recently refused devices too. Ask the user for the IDs, then:

```yaml
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    action: [request]
    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && !(subject.device in ['Xq3…', 'Pb9…'])"
    prompt: This device is not on the list. Ask the owner to add its device ID.
```

**Read-only devices** — a second rule refuses everything but `read` channels, plus file writes:

```yaml
shuvix-policy-rules:
  - effect: deny
    subject.kind: [network]
    object.type: [channel]
    match: "inCidr(subject.address, '192.168.1.0/24') && object.access != 'read'"
    prompt: This device can only look.
  - effect: deny
    subject.kind: [network]
    object.type: [path]
    action: [write]
    match: "inCidr(subject.address, '192.168.1.0/24')"
```

Keep the test on `object.access`: a `deny` that names groups (`object.group in ['session', …]`)
without `&& object.access != 'read'` refuses the reads in those groups too. The page calls a few
non-`read` channels just to show things; if a read-only device's page
misbehaves, look at Recently refused and exempt those channel names in the `match`
(`&& !(object.channel in ['…'])`). `project:list`, `project:listArchived` and `project:getById`
are `admin` because projects carry their environment variables, sensitive ones included: exempt
them only if those values may be seen.

**Limited devices must not change the rules.** Any device that is not fully trusted should be
refused `admin` channels **and** file writes into ShuviX's own folders — otherwise it can rewrite
this very policy:

```yaml
- effect: deny
  subject.kind: [network]
  object.type: [channel]
  match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && object.access == 'admin'"
- effect: deny
  subject.kind: [network]
  object.type: [path]
  action: [write]
  match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && (inDir(object.path, vars.shuvixConfigDirs) || inDir(object.path, vars.botsDir))"
```

**Files only from one folder:** refuse `path` reads outside it
(`!inDir(object.path, [vars.home + '/Shared'])`). Previews of files elsewhere then fail too.

## What a policy cannot do

- **It is not authentication.** Addresses can be taken by anyone on the same network; headers,
  cookies and the user agent are whatever the sender writes. A **device ID** is a random value
  ShuviX gives each browser in a cookie (`shuvix_device`, sent automatically with every request
  to the same address): it identifies a browser, and anyone who can read the traffic (plain
  HTTP) or use that browser can copy it. It changes when site data is cleared or in a private
  window, and a browser has different IDs for `127.0.0.1` and for the LAN address.
- **An SSH tunnel looks like this computer**: every tunnelled connection comes from `127.0.0.1`,
  so addresses cannot tell tunnelled users apart.
- **Agents are a way around.** A device that may call `agent:prompt` (or `agent:respondToInput`,
  which answers an agent's question cards) can have an agent do anything the agent's own
  policies allow on this computer. Agent-side policies do not know which device sent the
  message. Treat "may talk to agents" as full control.
- **Policies decide whether a request proceeds; they do not filter what it returns.** A device
  allowed `session:list` sees every session.
- Public addresses never connect (the fixed private-network check comes first), including VPN
  ranges such as Tailscale's `100.64.0.0/10`.

## Verify

- `shuvix policy check [<file>]` (see Working with the user): the table of who gets in and what
  each may do, from the same engine and the same policies as real requests. A cell marked
  `ERROR` is a rule that fails to evaluate (listed under the table) — it refuses every such
  request.
- Settings → General → Network access shows the state of `network-admission`, the connected
  browsers with their device IDs and **Recently refused**: what was refused, from where, by which
  rule — the quickest way to see a policy work.
- Open the address on the device: a refused request shows the rule's `prompt` with the device ID
  and address.
- A change takes effect within a few seconds; a connected browser that a new rule refuses is
  disconnected.
