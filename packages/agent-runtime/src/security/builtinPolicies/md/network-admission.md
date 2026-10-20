---
shuvix: policy v1
shuvix-id: policy:builtin:network-admission
shuvix-builtin: true
name: network-admission
shuvix-displayName: Remote Access From This Computer Only
description: While remote access is on, only a browser on this computer can connect; every other device is refused until you replace this policy with your own network-admission.
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    action: [request]
    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1'])"
    prompt: This ShuviX only accepts connections from the computer it runs on. To let this device in, open ShuviX on that computer (or through an SSH tunnel), go to Settings → General → Network access and set up who may connect.
---

**What it does**: remote access lets a browser use ShuviX over the network —
with everything ShuviX can do on this computer, and without a password. This
policy keeps that to a browser on this computer: every HTTP request whose
sender is not this computer (`127.0.0.1` or `::1`) is refused, and the other
device sees the sentence above instead of ShuviX. An SSH tunnel arrives as
`127.0.0.1`, so it gets in.

**To let other devices in**: replace this policy — write your own
`~/.shuvix/policies/network-admission.md` (same `name`). A second policy
with an `allow` rule is not enough: a `deny` beats every allow. Settings →
General → Network access has a button that opens a new conversation with a
prompt for this: the agent asks which devices should connect and what each
may do, reads the `network-policy` entry of the ShuviX knowledge base and
writes the file.

**What it does not do**:

- It is not a password. Once you replace it, it is your policy that decides
  who gets in — by address, network, device or anything else the request
  carries.
- Three checks stay fixed whatever the policies say: the sender must be on a
  private network (or this computer), the `Host` header must be an IP
  address or `localhost` with ShuviX's port, and a WebSocket must come from
  the page ShuviX itself served.
- Disabling this policy (instead of replacing it) lets every device on the
  local network in.
