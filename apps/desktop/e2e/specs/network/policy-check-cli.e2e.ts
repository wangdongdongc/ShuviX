/**
 * `shuvix policy check`（2026-10-19）—— agent 核对远程访问策略的那条命令，经 harness 的 runCli 跑真的 CLI、连真的
 * 隔离实例（判定细节在单测 policyCheck.test.ts，这里钉的是整条路：CLI 拆参数、自己读文件、主进程现扫策略、真实引擎、
 * 文本与退出码回到命令行）。
 *
 *   PCC-1 不给文件：只有内置 → 本机全放、外网全拒（network-admission#0）；退出 0
 *   PCC-2 草稿（不在策略目录里）按装进去之后算：放了的网段放、外网拒；策略目录里什么也没多出来
 *   PCC-3 单个请求：--expect 对上 → 0；对不上 → 1、说是哪条规则在哪一步拒的
 *   PCC-4 用法错误 → 2（不认识的参数列出全部）；读不到的文件 → 2；--help → 0
 *   PCC-5 装上之后（拷进策略目录、不经应用）再不带文件查：认得出这份 —— 现扫，不等定时器
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, runCli, type E2EApp } from '../../harness/launch'
import { waitRendererReady } from '../../harness/seed'

let app: E2EApp
let draftDir: string
let policiesDir: string

const DRAFT = [
  '---',
  'shuvix: policy v1',
  'name: network-admission',
  'shuvix-policy-scope: { subject.kind: [network], object.type: [request] }',
  'shuvix-policy-rules:',
  '  - effect: deny',
  "    match: \"!inCidr(subject.address, ['127.0.0.0/8', '::1', '192.168.77.0/24'])\"",
  '    prompt: Not on the list.',
  '---',
  '',
  'This computer and 192.168.77.0/24.',
  ''
].join('\n')

function line(stdout: string, start: string): string {
  const found = stdout.split('\n').find((l) => l.startsWith(start))
  expect(found, `"${start}" in\n${stdout}`).toBeDefined()
  return found!.replace(/\s+/g, ' ').trim()
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  draftDir = join(app.home, 'draft')
  mkdirSync(draftDir, { recursive: true })
  writeFileSync(join(draftDir, 'network-admission.md'), DRAFT)
  policiesDir = join(app.home, '.shuvix', 'policies')
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('shuvix policy check', () => {
  it('PCC-1 no file: only the builtin — this computer in, outside refused', async () => {
    const r = await runCli(app, ['policy', 'check'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('Checked the policies in effect now.')
    expect(r.stdout).toContain('network-admission (built-in)')
    expect(line(r.stdout, 'this computer')).toBe('this computer 127.0.0.1 allow allow allow allow')
    expect(line(r.stdout, 'outside')).toBe(
      'outside 203.0.113.9 deny deny deny deny ← network-admission#0'
    )
  })

  it('PCC-2 a draft outside the policies folder is checked as if installed; nothing gets installed', async () => {
    const draft = join(draftDir, 'network-admission.md')
    const r = await runCli(app, ['policy', 'check', draft])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain(
      'as if installed at ~/.shuvix/policies/network-admission.md (a new file there).'
    )
    expect(r.stdout).toContain('network-admission (your file network-admission.md)')
    expect(line(r.stdout, 'outside')).toContain('deny deny deny deny ← network-admission#0')
    expect(existsSync(policiesDir) ? readdirSync(policiesDir) : []).toEqual([])
  })

  it('PCC-3 one request: --expect matches → 0, differs → 1 with the rule and the step', async () => {
    const draft = join(draftDir, 'network-admission.md')
    const ok = await runCli(app, [
      'policy',
      'check',
      draft,
      '--from',
      '192.168.77.20',
      '--channel',
      'session:list',
      '--expect',
      'allow'
    ])
    expect(ok.code, ok.stdout + ok.stderr).toBe(0)
    expect(ok.stdout).toContain('invoke session:list (group session, scope sessions, access read)')
    expect(ok.stdout).toContain('As expected (allow).')

    const bad = await runCli(app, [
      'policy',
      'check',
      draft,
      '--from=192.168.78.20',
      '--expect=allow'
    ])
    expect(bad.code).toBe(1)
    expect(bad.stdout).toContain('Result: deny')
    expect(bad.stdout).toContain(
      'NOT as expected: expected allow, got deny — network-admission#0 refused it at the request step.'
    )
  })

  it('PCC-4 usage errors exit 2; an unreadable file exits 2; --help exits 0', async () => {
    const unknown = await runCli(app, ['policy', 'check', '--ip', '1.2.3.4'])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('Unknown option --ip. Options: --from, --device, --page')
    expect(unknown.stderr).toContain('Usage: shuvix policy check')

    const missing = await runCli(app, ['policy', 'check', join(draftDir, 'nope.md')])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('policy check: cannot read')

    const help = await runCli(app, ['policy', 'check', '--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('Usage: shuvix policy check')
  })

  it('PCC-5 installed by copying the file in (not through the app): the next check sees it', async () => {
    mkdirSync(policiesDir, { recursive: true })
    copyFileSync(join(draftDir, 'network-admission.md'), join(policiesDir, 'network-admission.md'))
    const r = await runCli(app, ['policy', 'check', '--from', '192.168.77.20', '--expect', 'allow'])
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain('network-admission (your file network-admission.md)')
  })
})
