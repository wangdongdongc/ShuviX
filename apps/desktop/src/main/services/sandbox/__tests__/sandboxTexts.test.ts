/**
 * 讲沙箱的那些话 —— 守护「沙箱只把命令的文件访问收进本会话的目录，稍复杂的直接到沙箱外跑、交给
 * 自动审查」（2026-10-01）之后，每一处给模型、给用户看的文字都跟着改了口：
 *
 *  - TX-1 文字来源：bash 工具（沙箱固定为开）的描述与 `dangerouslyDisableSandbox` 参数说明、一次被拒的
 *    `[sandbox]` 说明（能 / 不能越界两版）、界面文案（工具卡的 confinedHint、设置页的 sandboxSectionHint，
 *    en / zh / ja）、两份相关内置策略（ask-on-command / ask-on-external-path，各语言的描述 + 正文 + 规则
 *    提示语）。都不能再说已经不成立的范围（包缓存与 /tmp 可写、「除凭据外都能读」、git hooks / ShuviX
 *    自己的文件这道围栏）、提已删的策略与变量，或劝模型「别一上来就越界」。
 *  - TX-2 都讲到边界在家目录（参数说明除外：它指回工具描述）；给模型越界出路的几处都说有自动审查、
 *    都劝它一开始就越界，而不是先受限试一次。
 *  - TX-3 与规格对得上：受限命令能写的恰是会话目录（工作目录、$TMPDIR …）；策略正文说两面用同一份
 *    `vars.sessionDirs`；ask-on-command 讲的防越狱入口（open / osascript / launchctl）就是 profile 尾部拒的那几样。
 *  - TX-4 接线：main 只注入开关的读取口；凭据清单的读取口、沙箱视图都随这次删了。
 *
 * 内置说明书（resources/knowledge）由别处守护，这里不读。
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shuvix-sandbox-texts-test', isPackaged: false }
}))
// 工具构造时 pinSession 为真 = 本会话的命令套沙箱 → 描述带上受限范围那一段、schema 带上越界参数
vi.mock('../index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index')>()
  return { ...actual, pinSession: () => true, sandboxGloballyActive: () => true }
})
vi.mock('../../toolContext', () => ({
  getDesktopSecurityContext: () => ({ enforceCommand: vi.fn() }),
  getSessionPathGrants: () => ({ grantedWrite: [], grantedRead: [] }),
  sessionDirExtras: () => ({ readWrite: [], readOnly: [] }),
  resolveProjectConfig: () => ({ workingDirectory: '/w', envVars: {} }),
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../../i18n', () => ({ t: (key: string) => key }))

import { parsePolicyDefinitionFile } from '@shuvix/agent-runtime'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'
/* eslint-disable boundaries/dependencies -- 文字守护要拿到工具真实的描述：有意从沙箱模块的用例里构造扁平的 bash 工具 */
import { BashTool } from '../../../tools/bash'
import type { ToolContext } from '../../toolContext'
/* eslint-enable boundaries/dependencies */
import { compileSeatbeltProfile } from '../backends/seatbelt/profile'
import { explainSandboxDenial } from '../classify'
import { buildSandboxSpec } from '../spec'
import type { SandboxSpec } from '../types'

/** src/main/services/sandbox/__tests__ 往上：3 级是 src/main，7 级是仓库根 */
const MAIN_DIR = join(__dirname, '../../..')
const REPO_ROOT = join(__dirname, '../../../../../../..')
const LANGS = ['en', 'zh', 'ja'] as const
type Lang = (typeof LANGS)[number]

const readMd = createInlinePolicyMdReader()

/** 一份内置策略某种语言的人读面：描述 + 正文 + 每条规则的提示语 */
function policyText(name: string, lang: Lang): string {
  const fileName = lang === 'en' ? `${name}.md` : `${name}.${lang}.md`
  const raw = readMd(fileName)
  expect(raw, fileName).not.toBeNull()
  const parsed = parsePolicyDefinitionFile(raw!, name)
  expect(parsed, fileName).not.toBeNull()
  return [parsed!.description, parsed!.body, ...parsed!.rules.map((r) => r.prompt ?? '')].join('\n')
}

function localeString(lang: string, path: string): string {
  const json = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages/chat-protocol/src/i18n/locales', `${lang}.json`), 'utf8')
  ) as Record<string, unknown>
  const value = path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], json)
  expect(typeof value, `${lang}: ${path}`).toBe('string')
  return value as string
}

function fixtureSpec(): SandboxSpec {
  const built = buildSandboxSpec(
    {
      home: '/Users/u',
      userData: '/Users/u/Library/Application Support/ShuviX',
      shuvixHome: '/Users/u/.shuvix',
      toolResultsBase: '/Users/u/Library/Application Support/ShuviX/tool_results',
      uid: 501,
      cliSocket: '/Users/u/.shuvix/cli.sock',
      cliToken: '/Users/u/.shuvix/cli-token',
      appPaths: [],
      tmpRoot: '/private/tmp/shuvix-501'
    },
    { sessionId: 'sess-1', workingDirectory: '/Users/u/proj', grantedRead: [], grantedWrite: [] },
    (p) => p
  )
  if (!built.ok) throw new Error(built.reason)
  return built.spec
}

/** 一次被沙箱拒的写入 + 读取的说明 */
function denialNote(offerEscalation: boolean): string {
  const note = explainSandboxDenial({
    spec: fixtureSpec(),
    outputTail:
      'touch: /private/tmp/x: Operation not permitted\ncat: /Users/u/.gitconfig: Operation not permitted',
    exitCode: 1,
    offerEscalation
  })
  expect(note).not.toBeNull()
  return note!
}

const bash = new BashTool({ sessionId: 'sess-texts' } as ToolContext)
const BASH_DESCRIPTION = bash.description
const DISABLE_PARAM = (
  bash.parameters as unknown as {
    properties: Record<string, { description?: string } | undefined>
  }
).properties.dangerouslyDisableSandbox?.description

/** 全部文字来源：[标签, 文字] */
function sources(): Array<[string, string]> {
  const out: Array<[string, string]> = [
    ['bash tool description (sandbox pinned on)', BASH_DESCRIPTION],
    ['dangerouslyDisableSandbox param', DISABLE_PARAM ?? ''],
    ['[sandbox] denial note (escalation offered)', denialNote(true)],
    ['[sandbox] denial note (no escalation)', denialNote(false)]
  ]
  for (const lang of LANGS) {
    out.push([
      `${lang} toolCall.sandbox.confinedHint`,
      localeString(lang, 'toolCall.sandbox.confinedHint')
    ])
    out.push([
      `${lang} settings.sandboxSectionHint`,
      localeString(lang, 'settings.sandboxSectionHint')
    ])
    for (const name of ['ask-on-command', 'ask-on-external-path']) {
      out.push([`${name}.${lang}`, policyText(name, lang)])
    }
  }
  return out
}

/** 已经不成立、或指向已删东西的说法 */
const BANNED: RegExp[] = [
  // 放行清单：包缓存与 /tmp 可写
  /package[- ]?(manager )?caches?/i,
  /包(管理器)?缓存/,
  /パッケージ(マネージャ)?の?キャッシュ/,
  /(^|[\s,(])\/tmp\b/,
  // 「除凭据外都能读」
  /(?<!not )(?<!cannot )read anything/i,
  /except credentials/i,
  // 围栏：git hooks、ShuviX 自己的文件
  /git hooks|\.git\/hooks/i,
  /ShuviX's own files|ShuviX 自己的文件|ShuviX 自身のファイル/,
  // 已删的策略与变量
  /ask-on-write|ask-on-read|protect-credentials|session-grants/,
  /sandbox(Active|Writable|WriteDenied|Protected|Read)/,
  /workspace(Writable|WriteDenied|ProtectedPatterns)/,
  // 旧的越界口径：别一上来就越界、改在工作目录里做
  /never as a first attempt/i,
  /inside the working directory instead/i
]

/** 讲到边界在家目录 */
const MENTIONS_HOME = /home folder|家目录|ホームフォルダ/i
/** 讲到自动审查 */
const MENTIONS_REVIEW = /automatic (review|reviewer)|自动审查|自動レビュー/i

describe('TX-1 讲沙箱的文字跟着改了口', () => {
  const all = sources()

  it('TX-1 语料齐全：每一处都读到了、都不是空的（bash 描述确实带着受限那一段，参数确实在 schema 里）', () => {
    expect(all).toHaveLength(4 + LANGS.length * 4)
    for (const [label, text] of all) expect(text.trim(), label).not.toBe('')
    expect(BASH_DESCRIPTION).toContain('confined in a sandbox')
    expect(BASH_DESCRIPTION).toContain('dangerouslyDisableSandbox')
    expect(DISABLE_PARAM).toBeDefined()
  })

  it.each(BANNED.map((re) => [String(re), re] as const))('TX-1 没有哪一处匹配 %s', (_label, re) => {
    const hits = all.filter(([, text]) => re.test(text)).map(([label]) => label)
    expect(hits).toEqual([])
  })
})

describe('TX-2 边界在家目录；越界有自动审查，而且该一开始就越界', () => {
  const all = sources()

  it('TX-2 除了参数说明（它指回工具描述），每一处都讲到家目录', () => {
    const missing = all
      .filter(([label]) => label !== 'dangerouslyDisableSandbox param')
      .filter(([, text]) => !MENTIONS_HOME.test(text))
      .map(([label]) => label)
    expect(missing).toEqual([])
    expect(DISABLE_PARAM).toContain('see the tool description')
  })

  it('TX-2 给模型越界出路的几处、设置页与 ask-on-command 都讲到自动审查', () => {
    const offering = all.filter(
      ([label]) =>
        label.startsWith('bash tool description') ||
        label === 'dangerouslyDisableSandbox param' ||
        label === '[sandbox] denial note (escalation offered)' ||
        label.endsWith('settings.sandboxSectionHint') ||
        label.startsWith('ask-on-command.')
    )
    expect(offering).toHaveLength(3 + LANGS.length * 2)
    const missing = offering.filter(([, text]) => !MENTIONS_REVIEW.test(text)).map(([l]) => l)
    expect(missing).toEqual([])
  })

  it('TX-2 工具描述与参数说明都劝模型一开始就越界，而不是先受限试一次', () => {
    expect(BASH_DESCRIPTION).toContain('rather than trying confined first')
    expect(DISABLE_PARAM).toContain('rather than trying confined first')
    expect(DISABLE_PARAM).toContain('set it on the first attempt')
  })

  it('TX-2 不能越界的那一版说明不提参数、也不提审查', () => {
    const note = denialNote(false)
    expect(note).not.toContain('dangerouslyDisableSandbox')
    expect(note).not.toMatch(MENTIONS_REVIEW)
    expect(note.split('\n').at(-1)).toBe('Tell the user what the command needs.')
  })
})

describe('TX-3 与规格对得上', () => {
  it('TX-3 「只能读写工作目录与 $TMPDIR」：规格里可写的恰是会话目录（工作目录、$TMPDIR、本会话 artifacts 与工具结果）', () => {
    const spec = fixtureSpec()
    expect(spec.writableRoots).toEqual(spec.sessionDirs)
    expect(spec.sessionDirs[0]).toBe(spec.workingDirectory)
    expect(spec.sessionDirs[1]).toBe(spec.tmpDir)
    for (const text of [BASH_DESCRIPTION, denialNote(true)]) {
      expect(text).toContain('working directory and $TMPDIR')
    }
  })

  it('TX-3 「家目录以外可读」：profile 里读的拒绝只有家目录那一行', () => {
    const spec = fixtureSpec()
    const { profile, params } = compileSeatbeltProfile(spec)
    const denies = profile.split('\n').filter((l) => l.startsWith('(deny file-read*'))
    expect(denies).toHaveLength(1)
    const key = /\(param "(P\d+)"\)/.exec(denies[0])![1]
    expect(params[key]).toBe(spec.home)
    expect(BASH_DESCRIPTION).toContain("outside the user's home folder")
  })

  it.each(LANGS)(
    'TX-3 ask-on-external-path（%s）的正文说两面用同一份 vars.sessionDirs；ask-on-command 讲 profile 尾部拒的那几样（open / osascript / launchctl）',
    (lang) => {
      expect(policyText('ask-on-external-path', lang)).toContain('vars.sessionDirs')
      const command = policyText('ask-on-command', lang)
      for (const entry of ['`open`', '`osascript`', '`launchctl`', 'dangerouslyDisableSandbox']) {
        expect(command, entry).toContain(entry)
      }
      const { profile } = compileSeatbeltProfile(fixtureSpec())
      expect(profile).toContain('(deny lsopen)')
      expect(profile).toContain('(deny appleevent-send)')
      expect(profile).toContain('(deny job-creation)')
    }
  )
})

describe('TX-4 接线', () => {
  it('TX-4 main 启动时只注入开关的读取口；凭据清单的读取口已删', () => {
    const source = readFileSync(join(MAIN_DIR, 'index.ts'), 'utf8')
    expect(source).toContain('setSandboxSettingReader(')
    expect(source).not.toContain('setSandboxCredentialReader')
    expect(source).not.toContain('sessionCredentialPaths')
  })

  it('TX-4 沙箱模块的出口：会话目录清单还在，凭据读取口与沙箱视图都不在了', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../index')
    expect(typeof actual.sessionDirsView).toBe('function')
    for (const gone of [
      'setSandboxCredentialReader',
      'sessionView',
      'workspaceWriteView',
      'INACTIVE_VIEW'
    ]) {
      expect(actual, gone).not.toHaveProperty(gone)
    }
  })
})
