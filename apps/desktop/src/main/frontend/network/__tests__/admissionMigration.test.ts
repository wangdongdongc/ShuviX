/**
 * `frontend/network/admissionMigration.ts` —— 旧的局域网共享设置 → network-admission 用户策略（2026-10-19）。写出来的原文
 * 用 agent-runtime 的解析器与引擎真的判一遍：
 *
 *   AM-1 legacySharingOf：只有 lan 'true' 才算；带了网络（去空白）→ interface
 *   AM-2 legacyCidrOf：网卡名取第一个 IPv4（没有就取非链路本地的 IPv6）；地址取它那一条；内部网卡、找不到 → undefined
 *   AM-3 局域网共享 → 合法策略、沿用内置 id、规则为空：任何对端都放
 *   AM-4 指定网卡（找得到）→ 只放本机与那个网段；找不到 → 按「从那块网卡进来」写（subject.interface）；指定地址找不到 →
 *        按 subject.localAddress 写
 *   AM-5 migrateLegacySharing：没有共享 → 不写；不合法的网络 → 不写、告警；已有同名用户策略 → 不写；写失败 → 告警、回 false
 *   AM-6 networkAdmissionOf：生效的是内置 → builtin；用户的 → override；停用 → disabled
 */
import { describe, expect, it, vi } from 'vitest'
import type { networkInterfaces } from 'node:os'
import {
  assembleRules,
  evaluateSecurity,
  parsePolicyDefinitionFile,
  type SecurityHostProvider,
  type UserPolicyFile
} from '@shuvix/agent-runtime'
import { createInlinePolicyMdReader } from '../../../../../../../packages/agent-runtime/src/security/builtinPolicies/inlineSources'
import {
  legacyAdmissionPolicyText,
  legacyCidrOf,
  legacySharingOf,
  migrateLegacySharing,
  networkAdmissionOf
} from '../admissionMigration'

type Interfaces = ReturnType<typeof networkInterfaces>

const IFACES = {
  eth0: [
    { address: 'fe80::1', family: 'IPv6', internal: false, cidr: 'fe80::1/64' },
    { address: '10.0.0.5', family: 'IPv4', internal: false, cidr: '10.0.0.5/24' }
  ],
  eth1: [{ address: '192.168.50.10', family: 'IPv4', internal: false, cidr: '192.168.50.10/24' }],
  v6only: [
    { address: 'fe80::9', family: 'IPv6', internal: false, cidr: 'fe80::9/64' },
    { address: 'fd00::9', family: 'IPv6', internal: false, cidr: 'fd00::9/64' }
  ],
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, cidr: '127.0.0.1/8' }]
} as unknown as Interfaces

const READ_MD = createInlinePolicyMdReader()

/** 把一份原文当用户策略装上，判某个对端地址的请求 */
function judge(text: string, address: string, attrs: Record<string, unknown> = {}): string {
  const parsed = parsePolicyDefinitionFile(text, 'x')
  expect(parsed, text).not.toBeNull()
  const user: UserPolicyFile = { ...parsed!, fileName: 'network-admission.md' }
  const provider: SecurityHostProvider = {
    host: 'desktop',
    pathSep: '/',
    getVars: () => ({}),
    getSessionGrants: () => ({ allowList: [] }),
    readBuiltinPolicyMd: READ_MD,
    getUserPolicies: () => [user]
  }
  return evaluateSecurity(assembleRules(provider), {
    subject: { kind: 'network', sessionId: '', attrs: { address, ...attrs } },
    action: 'request',
    object: { type: 'request', method: 'GET', path: '/', query: {}, route: 'page' },
    environment: { host: 'desktop' }
  }).effect
}

describe('admissionMigration', () => {
  it('AM-1 legacySharingOf', () => {
    expect(legacySharingOf(undefined, 'eth1')).toBeUndefined()
    expect(legacySharingOf('false', 'eth1')).toBeUndefined()
    expect(legacySharingOf('TRUE', undefined)).toBeUndefined()
    expect(legacySharingOf('true', undefined)).toEqual({ kind: 'lan' })
    expect(legacySharingOf('true', '  ')).toEqual({ kind: 'lan' })
    expect(legacySharingOf('true', ' eth1 ')).toEqual({ kind: 'interface', spec: 'eth1' })
  })

  it('AM-2 legacyCidrOf', () => {
    expect(legacyCidrOf('eth0', IFACES)).toBe('10.0.0.5/24')
    expect(legacyCidrOf('eth1', IFACES)).toBe('192.168.50.10/24')
    expect(legacyCidrOf('192.168.50.10', IFACES)).toBe('192.168.50.10/24')
    expect(legacyCidrOf('v6only', IFACES)).toBe('fd00::9/64')
    expect(legacyCidrOf('lo0', IFACES)).toBeUndefined()
    expect(legacyCidrOf('eth9', IFACES)).toBeUndefined()
  })

  it('AM-3 局域网共享：规则为空，任何对端都放', () => {
    const text = legacyAdmissionPolicyText({ kind: 'lan' }, IFACES)
    expect(text).toContain('shuvix-id: policy:builtin:network-admission')
    expect(text).toContain('shuvix-policy-rules: []')
    expect(judge(text, '192.168.1.23')).toBe('allow')
    expect(judge(text, '10.9.9.9')).toBe('allow')
  })

  it('AM-4 指定网络：只放本机与那个网段；找不到网卡 / 地址按进来的网卡 / 本机地址写', () => {
    const scoped = legacyAdmissionPolicyText({ kind: 'interface', spec: 'eth1' }, IFACES)
    expect(judge(scoped, '192.168.50.77')).toBe('allow')
    expect(judge(scoped, '127.0.0.1')).toBe('allow')
    expect(judge(scoped, '10.0.0.9')).toBe('deny')
    const missing = legacyAdmissionPolicyText({ kind: 'interface', spec: 'eth9' }, IFACES)
    expect(missing).toContain("subject.interface == 'eth9'")
    expect(judge(missing, '10.0.0.9', { interface: 'eth9' })).toBe('allow')
    expect(judge(missing, '10.0.0.9', { interface: 'eth0' })).toBe('deny')
    const address = legacyAdmissionPolicyText({ kind: 'interface', spec: '10.1.1.1' }, IFACES)
    expect(address).toContain("subject.localAddress == '10.1.1.1'")
    expect(judge(address, '10.0.0.9', { localAddress: '10.1.1.1' })).toBe('allow')
  })

  it('AM-5 migrateLegacySharing', () => {
    const logger = { info: vi.fn(), warn: vi.fn() }
    const createPolicy = vi.fn((_text: string) => ({ success: true }))
    const deps = { hasUserAdmission: () => false, createPolicy, interfaces: () => IFACES, logger }
    expect(migrateLegacySharing(undefined, deps)).toBe(false)
    expect(migrateLegacySharing({ kind: 'interface', spec: "a'b" }, deps)).toBe(false)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(createPolicy).not.toHaveBeenCalled()
    expect(migrateLegacySharing({ kind: 'lan' }, { ...deps, hasUserAdmission: () => true })).toBe(
      false
    )
    expect(createPolicy).not.toHaveBeenCalled()
    expect(migrateLegacySharing({ kind: 'lan' }, deps)).toBe(true)
    expect(createPolicy).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledTimes(1)
    const failing = vi.fn(() => ({ success: false, error: 'disk full' }))
    expect(migrateLegacySharing({ kind: 'lan' }, { ...deps, createPolicy: failing })).toBe(false)
    expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining('disk full'))
  })

  it('AM-6 networkAdmissionOf', () => {
    expect(networkAdmissionOf([{ name: 'network-admission', source: 'builtin' }])).toBe('builtin')
    expect(
      networkAdmissionOf([
        { name: 'network-admission', source: 'builtin', overridden: true },
        { name: 'network-admission', source: 'user' }
      ])
    ).toBe('override')
    expect(
      networkAdmissionOf([{ name: 'network-admission', source: 'builtin', disabled: true }])
    ).toBe('disabled')
    expect(
      networkAdmissionOf([{ name: 'network-admission', source: 'user', disabled: true }])
    ).toBe('disabled')
  })
})
