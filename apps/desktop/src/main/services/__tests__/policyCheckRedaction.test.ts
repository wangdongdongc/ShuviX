/**
 * `shuvix policy check --redaction`（policyCheck.ts + policyCheckRedaction.ts）：真引擎 + 内置策略 + 用户策略。
 *
 *   PCR-1 只有内置：每个模型的请求都脱敏；四类照发，其余保持占位符；列的是脱敏的服务商（各取第一个模型）
 *   PCR-2 草稿文件：信任一个服务商 → 那一行是 trusted、不进第二张表；草稿顶替同名的那份
 *   PCR-3 单类：--category（带 --value）逐个模型给出处理与胜出规则；--expect 对不上 → 退出码 1，对上 → 0
 *   PCR-4 请求那一层的 --expect；--bot 让 subject.bot 起作用
 *   PCR-5 用法：--redaction 不带网络的选项、网络核对不带脱敏的选项、--model 要 --provider、未知类别、--value 要 --category
 *   PCR-6 写入回执：管脱敏的策略提示 `--redaction`，管网络的仍是网络那一句，别的没有
 */
import { describe, expect, it } from 'vitest'
import type { networkInterfaces } from 'node:os'
import {
  buildBuiltinPolicies,
  createSecurityContext,
  parsePolicyDefinitionFile,
  type UserPolicyFile
} from '@shuvix/agent-runtime'
import { createInlinePolicyMdReader } from '../../../../../../packages/agent-runtime/src/security/builtinPolicies/inlineSources'
import { runPolicyCheck, type PolicyCheckDeps } from '../policyCheck'
import { policyCheckHint } from '../policyCheckHint'

const HOME = '/Users/u'
const POLICIES = `${HOME}/.shuvix/policies`
const READ_MD = createInlinePolicyMdReader()

const MODELS = [
  { provider: 'anthropic', model: 'claude-x' },
  { provider: 'anthropic', model: 'claude-y' },
  { provider: 'home-ai', model: 'qwen3-32b' }
]

function policyText(name: string, rules: string): string {
  return `---\nshuvix: policy v1\nname: ${name}\nshuvix-policy-rules:\n${rules}\n---\n`
}

function userFile(text: string, fileName: string): UserPolicyFile {
  const parsed = parsePolicyDefinitionFile(text, fileName.replace(/\.md$/, ''))
  expect(parsed, text).not.toBeNull()
  return { ...parsed!, fileName }
}

const TRUST_HOME = `  - effect: force-allow
    subject.kind: [agent]
    action: [send]
    object.type: [modelRequest]
    match: "object.provider == 'home-ai'"`

const MAIL_AND_TEST_KEYS = `  - effect: force-allow
    subject.kind: [agent]
    action: [disclose]
    object.type: [sensitive]
    match: "object.category == 'EMAIL' || object.value.startsWith('sk-test-')"
  - effect: deny
    subject.kind: [agent]
    action: [disclose]
    object.type: [sensitive]
    match: "object.category == 'PRIVATE_KEY'"
    prompt: Private keys never leave.`

function deps(users: UserPolicyFile[] = []): PolicyCheckDeps {
  return {
    policiesDir: POLICIES,
    home: HOME,
    userPolicies: () => users,
    builtinPolicies: () => buildBuiltinPolicies({ language: 'en', readMd: READ_MD }),
    isDisabled: () => false,
    contextFor: () => () => {
      throw new Error('network context not used here')
    },
    status: () => ({ port: 7766, clients: [], denials: [] }),
    interfaces: () => ({}) as ReturnType<typeof networkInterfaces>,
    redaction: {
      models: () => MODELS,
      agentContextFor: (userPolicies, logger, subject) =>
        createSecurityContext(
          { kind: 'agent', sessionId: '', agentKind: 'root', attrs: { bot: subject.bot ?? '' } },
          { host: 'desktop', platform: 'darwin' },
          {
            host: 'desktop',
            pathSep: '/',
            getVars: () => ({ home: HOME }),
            readBuiltinPolicyMd: READ_MD,
            getUserPolicies: () => userPolicies,
            logger
          }
        )
    }
  }
}

const run = (
  flags: Array<[string, string]>,
  opts: { users?: UserPolicyFile[]; file?: { path: string; text: string } } = {}
): ReturnType<typeof runPolicyCheck> =>
  runPolicyCheck(
    { flags: [['redaction', ''], ...flags], ...(opts.file ? { file: opts.file } : {}) },
    deps(opts.users)
  )

/** 表格里以 first 开头的那一行，按两个以上空格切开 */
const row = (stdout: string, first: string): string[] =>
  stdout
    .split('\n')
    .find((l) => l.startsWith(`${first} `))!
    .split(/ {2,}/)

describe('policy check --redaction', () => {
  it('PCR-1 只有内置', () => {
    const result = run([])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Redaction policies: redact-sensitive (built-in)')
    expect(row(result.stdout, 'anthropic')).toEqual([
      'anthropic',
      'claude-x',
      'redacted',
      'redact-sensitive#0'
    ])
    expect(row(result.stdout, 'home-ai').slice(0, 3)).toEqual(['home-ai', 'qwen3-32b', 'redacted'])
    expect(row(result.stdout, 'category')).toEqual([
      'category',
      'anthropic / claude-x',
      'home-ai / qwen3-32b'
    ])
    expect(row(result.stdout, 'API_KEY')).toEqual(['API_KEY', 'placeholder', 'placeholder'])
    expect(row(result.stdout, 'USERNAME')).toEqual(['USERNAME', 'real value', 'real value'])
    expect(row(result.stdout, 'BUCKET')).toEqual(['BUCKET', 'real value', 'real value'])
  })

  it('PCR-2 草稿：信任一个服务商', () => {
    const file = { path: '/tmp/trust-home.md', text: policyText('trust-home', TRUST_HOME) }
    const result = run([], { file })
    expect(result.stdout).toContain(
      `Checked /tmp/trust-home.md as if installed at ~/.shuvix/policies/trust-home.md`
    )
    expect(result.stdout).toContain('trust-home (your file trust-home.md)')
    expect(row(result.stdout, 'home-ai')).toEqual([
      'home-ai',
      'qwen3-32b',
      'real values (trusted)',
      'trust-home#0'
    ])
    expect(row(result.stdout, 'category')).toEqual(['category', 'anthropic / claude-x'])
  })

  it('PCR-3 单类与 --expect', () => {
    const users = [userFile(policyText('mine', MAIL_AND_TEST_KEYS), 'mine.md')]
    const mail = run(
      [
        ['category', 'email'],
        ['expect', 'send']
      ],
      { users }
    )
    expect(mail.exitCode).toBe(0)
    expect(mail.stdout).toContain('- anthropic / claude-x: real value (mine#0)')

    const testKey = run(
      [
        ['category', 'API_KEY'],
        ['value', 'sk-test-abc123'],
        ['provider', 'anthropic'],
        ['model', 'claude-y']
      ],
      { users }
    )
    expect(
      testKey.stdout.split('\n').filter((l) => l.startsWith('- ') || l.startsWith('✗ '))
    ).toEqual(['- anthropic / claude-y: real value (mine#0)'])

    const key = run(
      [
        ['category', 'PRIVATE_KEY'],
        ['expect', 'redact']
      ],
      { users }
    )
    expect(key.exitCode).toBe(1)
    expect(key.stdout).toContain('✗ anthropic / claude-x: not sent (mine#1) — expected placeholder')
  })

  it('PCR-4 请求那一层的 --expect；--bot', () => {
    const botOnlyHome = `  - effect: deny
    subject.kind: [agent]
    action: [send]
    object.type: [modelRequest]
    match: "subject.bot == 'bot:my-bot' && object.provider != 'home-ai'"`
    const users = [userFile(policyText('bot-home', botOnlyHome), 'bot-home.md')]
    expect(
      run(
        [
          ['provider', 'anthropic'],
          ['expect', 'redact']
        ],
        { users }
      ).exitCode
    ).toBe(0)
    const asBot = run(
      [
        ['provider', 'anthropic'],
        ['bot', 'bot:my-bot'],
        ['expect', 'block']
      ],
      { users }
    )
    expect(asBot.exitCode).toBe(0)
    expect(asBot.stdout).toContain('the root agent of bot bot:my-bot')
    expect(row(asBot.stdout, 'anthropic')).toEqual([
      'anthropic',
      'claude-x',
      'not sent',
      'bot-home#0'
    ])
    expect(
      run(
        [
          ['provider', 'home-ai'],
          ['bot', 'bot:my-bot'],
          ['expect', 'block']
        ],
        { users }
      ).exitCode
    ).toBe(1)
  })

  it('PCR-5 用法', () => {
    const usage = (flags: Array<[string, string]>, redaction = true): string => {
      const result = runPolicyCheck(
        { flags: redaction ? [['redaction', ''], ...flags] : flags },
        deps()
      )
      expect(result.exitCode).toBe(2)
      return result.stderr
    }
    expect(usage([['from', '192.168.1.2']])).toMatch(/does not take --from/)
    expect(usage([['category', 'EMAIL']], false)).toMatch(/--category only go with --redaction/)
    expect(usage([['model', 'x']])).toMatch(/--model needs --provider/)
    expect(usage([['category', 'NOPE']])).toMatch(/Unknown category 'NOPE'/)
    expect(usage([['value', 'x']])).toMatch(/--value needs --category/)
    expect(usage([['expect', 'allow']])).toMatch(/redact, send or block/)
  })

  it('PCR-6 写入回执', () => {
    expect(policyCheckHint(`${POLICIES}/mine.md`, policyText('mine', MAIL_AND_TEST_KEYS))).toMatch(
      /shuvix policy check \/Users\/u\/\.shuvix\/policies\/mine\.md --redaction/
    )
    expect(
      policyCheckHint(
        `${POLICIES}/asks.md`,
        policyText('asks', '  - effect: ask\n    subject.kind: [agent]\n    object.type: [command]')
      )
    ).toBeNull()
    expect(
      policyCheckHint(
        `${POLICIES}/network-admission.md`,
        policyText(
          'network-admission',
          '  - effect: deny\n    subject.kind: [network]\n    object.type: [request]'
        )
      )
    ).toMatch(/which devices get in/)
  })
})
