/**
 * `shuvix policy check --redaction`（policyCheck.ts + policyCheckRedaction.ts）：真引擎 + 内置策略 + 用户策略。
 *
 *   PCR-1 只有内置：每个模型的新内容都脱敏；四类存真值，其余存占位符；列的是脱敏的服务商（各取第一个模型）
 *   PCR-2 草稿文件：信任一个服务商 → 那一行 not redacted、不进第二张表；草稿顶替同名的那份；单类说明原因
 *   PCR-3 单类：--category（带 --value）逐个模型给出处理与胜出规则；这一类 deny = 存占位符，--expect block 和 redact 都算对，
 *         send 对不上 → 退出码 1
 *   PCR-4 请求那一层的 --expect；--bot 让 subject.bot 起作用；第一层 deny 的单类：not sent，--expect block 对、redact 错
 *   PCR-5 用法：--redaction 不带网络的选项、网络核对不带脱敏的选项、--model 要 --provider、未知类别、--value 要 --category
 *   PCR-6 写入回执：管脱敏的策略提示 `--redaction`，管网络的仍是网络那一句，别的没有
 *   PCR-7 全部 force-allow：说明新内容对任何模型都不脱敏，没有第二张表
 *   PCR-8 内置策略被关：每行 no rule matched，同样没有第二张表
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

function deps(users: UserPolicyFile[] = [], disabled = false): PolicyCheckDeps {
  return {
    policiesDir: POLICIES,
    home: HOME,
    userPolicies: () => users,
    builtinPolicies: () => buildBuiltinPolicies({ language: 'en', readMd: READ_MD }),
    isDisabled: () => disabled,
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
            isPolicyDisabled: () => disabled,
            logger
          }
        )
    }
  }
}

const run = (
  flags: Array<[string, string]>,
  opts: { users?: UserPolicyFile[]; file?: { path: string; text: string }; disabled?: boolean } = {}
): ReturnType<typeof runPolicyCheck> =>
  runPolicyCheck(
    { flags: [['redaction', ''], ...flags], ...(opts.file ? { file: opts.file } : {}) },
    deps(opts.users, opts.disabled)
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
      'new content redacted',
      'redact-sensitive#0'
    ])
    expect(row(result.stdout, 'home-ai').slice(0, 3)).toEqual([
      'home-ai',
      'qwen3-32b',
      'new content redacted'
    ])
    expect(result.stdout).toContain('New content for each model, for ')
    expect(result.stdout).toContain('Sensitive content in new tool results and trigger messages')
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
      'not redacted',
      'trust-home#0'
    ])
    expect(row(result.stdout, 'category')).toEqual(['category', 'anthropic / claude-x'])
    const category = run([['category', 'EMAIL']], { file })
    expect(category.stdout).toContain(
      "- home-ai / qwen3-32b: real value (this model's requests are not redacted — trust-home#0)"
    )
    expect(category.stdout).toContain('- anthropic / claude-x: placeholder (redact-sensitive')
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

    // 这一类 deny = 存占位符：两种说法都对，表格里写成 placeholder (denied)
    const privateKey = (expected?: string): ReturnType<typeof run> =>
      run(
        [
          ['category', 'PRIVATE_KEY'],
          ...(expected === undefined ? [] : [['expect', expected] as [string, string]])
        ],
        { users }
      )
    expect(privateKey().stdout).toContain('- anthropic / claude-x: placeholder (denied) (mine#1)')
    expect(privateKey('block').exitCode).toBe(0)
    expect(privateKey('redact').exitCode).toBe(0)
    const sent = privateKey('send')
    expect(sent.exitCode).toBe(1)
    expect(sent.stdout).toContain(
      '✗ anthropic / claude-x: placeholder (denied) (mine#1) — expected real value'
    )
    expect(row(run([], { users }).stdout, 'PRIVATE_KEY')).toEqual([
      'PRIVATE_KEY',
      'placeholder (denied)',
      'placeholder (denied)'
    ])
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
    // 单类：这个模型的请求根本不发
    const category = (expected: string): ReturnType<typeof run> =>
      run(
        [
          ['provider', 'anthropic'],
          ['model', 'claude-x'],
          ['bot', 'bot:my-bot'],
          ['category', 'EMAIL'],
          ['expect', expected]
        ],
        { users }
      )
    const blocked = category('block')
    expect(blocked.exitCode).toBe(0)
    expect(blocked.stdout).toContain(
      "- anthropic / claude-x: not sent (this model's requests are not sent — bot-home#0)"
    )
    expect(category('redact').exitCode).toBe(1)
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

  it('PCR-7 全部 force-allow：说明新内容对任何模型都不脱敏，没有第二张表', () => {
    const trustAll = `  - effect: force-allow
    subject.kind: [agent]
    action: [send]
    object.type: [modelRequest]`
    const result = run([], { users: [userFile(policyText('trust-all', trustAll), 'trust-all.md')] })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      'New content is not redacted for any model, so no category is stored as a placeholder.'
    )
    expect(row(result.stdout, 'anthropic')).toEqual([
      'anthropic',
      'claude-x',
      'not redacted',
      'trust-all#0'
    ])
    expect(result.stdout).not.toContain('Sensitive content in new tool results')
    expect(result.stdout).not.toMatch(/^category /m)
  })

  it('PCR-8 内置策略被关：每行 no rule matched，同样没有第二张表', () => {
    const result = run([], { disabled: true })
    expect(result.exitCode).toBe(0)
    for (const provider of ['anthropic', 'home-ai']) {
      const line = row(result.stdout, provider)
      expect(line[2]).toBe('not redacted')
      expect(line[3]).toBe('no rule matched')
    }
    expect(result.stdout).toContain(
      'New content is not redacted for any model, so no category is stored as a placeholder.'
    )
    expect(result.stdout).not.toContain('Sensitive content in new tool results')
  })
})
