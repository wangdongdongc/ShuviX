/**
 * 旧的局域网共享设置 → 一份 network-admission 用户策略（2026-10-19，docs/network-policy/design.md §6）。
 *
 * 从前「谁能连」由两个设置决定：`network.lan`（允许局域网里的其他设备，监听 0.0.0.0）与 `network.lanInterface`
 * （只开放给一块网卡 / 一个本机地址）；无头运行是 `--lan` / `--bind`。现在一律监听 0.0.0.0，谁能进由策略定，
 * 内置的 network-admission 只放这台电脑。为了不让已经开着局域网共享的人升级后突然连不上（无头的服务器尤其
 * —— 那时只剩 SSH），开着共享的旧设置迁移成一份**同名用户策略**，复现原来的范围：
 *
 *  - 只开了局域网共享 → 规则为空：任何私有地址的设备都能进（写死的私有地址门仍在，公网进不来）；
 *  - 还指定了网络 → 只放这台电脑与那个网段（按迁移时那块网卡的网段写死；那时找不到网卡 → 按「从那块网卡 /
 *    那个本机地址进来」写）。
 *
 * 只在**还没有**同名用户策略时写（用户自己写过就不碰）；写出来的文件沿用内置的 id，停用开关照样管它。
 * 桌面：迁移后删掉两个旧设置键。无头：`--lan` / `--bind` 仍被接受（已有的服务文件不至于起不来），每次启动按同一条
 * 规则判断要不要写。
 */
import type { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import {
  isValidLanInterfaceSpec,
  NETWORK_ADMISSION_POLICY,
  type NetworkAdmission
} from '../../../shared/network'

type Interfaces = ReturnType<typeof networkInterfaces>

/** 旧设置里的共享范围 */
export type LegacySharing =
  | { readonly kind: 'lan' }
  | { readonly kind: 'interface'; readonly spec: string }

/** 网卡名或本机地址 → 那块网卡上的网段（`192.168.50.10/24`）；找不到 → undefined */
export function legacyCidrOf(spec: string, interfaces: Interfaces): string | undefined {
  const literal = isIP(spec) !== 0
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || !entry.cidr) continue
      if (literal ? entry.address === spec : name === spec) {
        // 网卡名：取第一个 IPv4（与旧的 resolveLanNetwork 同口径）
        if (!literal && entry.family !== 'IPv4') continue
        return entry.cidr
      }
    }
  }
  if (!literal) {
    // 网卡上没有 IPv4：退到它的第一个非链路本地 IPv6
    const entry = (interfaces[spec] ?? []).find(
      (e) => !e.internal && e.family === 'IPv6' && !/^fe80:/i.test(e.address) && e.cidr
    )
    if (entry?.cidr) return entry.cidr
  }
  return undefined
}

/** 迁移写出的策略原文（英文；正文说明它从哪来、怎么改） */
export function legacyAdmissionPolicyText(sharing: LegacySharing, interfaces: Interfaces): string {
  const head = [
    '---',
    'shuvix: policy v1',
    `shuvix-id: policy:builtin:${NETWORK_ADMISSION_POLICY}`,
    `name: ${NETWORK_ADMISSION_POLICY}`
  ]
  if (sharing.kind === 'lan') {
    return [
      ...head,
      'shuvix-displayName: Remote Access From the Local Network',
      'description: Written by ShuviX when it replaced the "Allow other devices on the local network" switch — any device on a private network can connect.',
      'shuvix-policy-rules: []',
      '---',
      '',
      'ShuviX wrote this file when it replaced the "Allow other devices on the local',
      'network" switch (or the `--lan` start option) with this policy. It keeps what the',
      'switch did: it has no rules, so every device on a private network (or this',
      'computer) can connect — ShuviX never accepts connections from public addresses.',
      '',
      'To narrow it down — one or a few networks, particular devices, read-only devices —',
      'edit the rules, or ask an agent: Settings → General → Network access has a prompt',
      'for this.',
      ''
    ].join('\n')
  }
  const spec = sharing.spec
  const cidr = legacyCidrOf(spec, interfaces)
  const literal = isIP(spec) !== 0
  const where = cidr
    ? `inCidr(subject.address, ['127.0.0.0/8', '::1', '${cidr}'])`
    : `inCidr(subject.address, ['127.0.0.0/8', '::1']) || ${literal ? 'subject.localAddress' : 'subject.interface'} == '${spec}'`
  const who = cidr ? `devices in ${cidr}` : `devices connecting through ${spec}`
  return [
    ...head,
    `shuvix-displayName: Remote Access From ${cidr ?? spec}`,
    `description: Written by ShuviX when it replaced the "Share on" network setting — only this computer and ${who} can connect.`,
    'shuvix-policy-scope:',
    '  subject.kind: [network]',
    '  object.type: [request]',
    'shuvix-policy-rules:',
    '  - effect: deny',
    '    action: [request]',
    `    match: "!(${where})"`,
    `    prompt: This ShuviX only accepts connections from the computer it runs on and ${who}.`,
    '---',
    '',
    'ShuviX wrote this file when it replaced the "Share on" network setting (or the',
    `\`--bind\` start option) with this policy. It keeps what the setting did: only this`,
    `computer and ${who} can connect.`,
    '',
    'To change who can connect, edit the rule, or ask an agent: Settings → General →',
    'Network access has a prompt for this.',
    ''
  ].join('\n')
}

/**
 * 迁移一次：`sharing` 没有（旧设置没开局域网共享）→ 什么也不写；有同名用户策略 → 不碰；否则写一份。
 * 回：写了没有（写失败只记日志 —— 那时内置的「只放这台电脑」照常生效，宁可连不上也不放开）
 */
export function migrateLegacySharing(
  sharing: LegacySharing | undefined,
  deps: {
    readonly hasUserAdmission: () => boolean
    readonly createPolicy: (text: string) => { success: boolean; error?: string }
    readonly interfaces: () => Interfaces
    readonly logger?: { info(message: string): void; warn(message: string): void }
  }
): boolean {
  if (sharing === undefined) return false
  if (sharing.kind === 'interface' && !isValidLanInterfaceSpec(sharing.spec)) {
    deps.logger?.warn(`network: legacy network "${sharing.spec}" is not valid; not migrated`)
    return false
  }
  if (deps.hasUserAdmission()) return false
  const result = deps.createPolicy(legacyAdmissionPolicyText(sharing, deps.interfaces()))
  if (!result.success) {
    deps.logger?.warn(
      `network: could not write the ${NETWORK_ADMISSION_POLICY} policy: ${result.error ?? ''}`
    )
    return false
  }
  deps.logger?.info(
    `network: wrote ~/.shuvix/policies/${NETWORK_ADMISSION_POLICY}.md from the old sharing setting`
  )
  return true
}

/** 旧设置值 → 共享范围（局域网开关不是 'true' → 没有；指定了合法的网络 → interface） */
export function legacySharingOf(
  lan: string | undefined,
  lanInterface: string | undefined
): LegacySharing | undefined {
  if (lan !== 'true') return undefined
  const spec = lanInterface?.trim()
  return spec ? { kind: 'interface', spec } : { kind: 'lan' }
}

/**
 * network-admission 此刻的状态（设置页的引导按它分三种）—— 按策略列表（同名裁决之后、带停用徽标的那份，
 * policyService.listForSettings）算：生效的那份停用了 → `disabled`；是用户的 → `override`；否则 `builtin`
 */
export function networkAdmissionOf(
  rows: readonly {
    readonly name: string
    readonly source: 'builtin' | 'user'
    readonly overridden?: boolean
    readonly disabled?: boolean
  }[]
): NetworkAdmission {
  const active = rows.find((row) => row.name === NETWORK_ADMISSION_POLICY && !row.overridden)
  if (!active) return 'override'
  if (active.disabled) return 'disabled'
  return active.source === 'user' ? 'override' : 'builtin'
}
