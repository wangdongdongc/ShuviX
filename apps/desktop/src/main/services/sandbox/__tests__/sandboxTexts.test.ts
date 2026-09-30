/**
 * 讲沙箱的那些话 —— 守护「沙箱只替内置策略在命令上生效，再加一道防越狱的围栏」这次收窄之后，
 * 每一处给模型、给用户看的文字都跟着改了口：
 *
 *  - TX-1 文字来源：bash 工具（沙箱固定为开）的描述、一次被拒写入的 `[sandbox]` 说明、界面文案
 *    （工具卡的 confinedHint、设置页的 sandboxSectionHint，en / zh / ja）、三份相关内置策略
 *    （ask-on-command / ask-on-write / protect-credentials，各语言的描述 + 正文 + 规则提示语）、
 *    以及内置说明书里的 policy-md.md。都不能再说「个人文件夹读不到」「ShuviX 的数据读不到」、
 *    提已删的 ask-on-read 或 sandboxRead* 变量、或说项目里的 .vscode 受保护；都得说到凭据。
 *    ask-on-command 的正文还得讲围栏：git hooks 与 ShuviX 自己的文件。
 *  - TX-2 接线：main 启动时把 sessionCredentialPaths 注入给沙箱（没注入 = 沙箱不护任何凭据）。
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shuvix-sandbox-texts-test', isPackaged: false }
}))
// 工具构造时 pinSession 为真 = 本会话的命令套沙箱 → 描述带上受限范围那一段
vi.mock('../index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index')>()
  return { ...actual, pinSession: () => true, sandboxGloballyActive: () => true }
})
vi.mock('../../toolContext', () => ({
  getDesktopSecurityContext: () => ({ enforceCommand: vi.fn() }),
  getSessionPathGrants: () => ({ grantedWrite: [], grantedRead: [] }),
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
import { explainSandboxDenial } from '../classify'
import { buildSandboxSpec } from '../spec'

/** src/main/services/sandbox/__tests__ 往上：3 级是 src/main，5 级是 apps/desktop，7 级是仓库根 */
const MAIN_DIR = join(__dirname, '../../..')
const DESKTOP_DIR = join(__dirname, '../../../../..')
const REPO_ROOT = join(__dirname, '../../../../../../..')
const LANGS = ['en', 'zh', 'ja'] as const

const readMd = createInlinePolicyMdReader()

/** 一份内置策略某种语言的人读面：描述 + 正文 + 每条规则的提示语 */
function policyText(name: string, lang: (typeof LANGS)[number]): string {
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

/** 一次被沙箱拒的写入的说明（带越界参数的那一版） */
function denialNote(): string {
  const built = buildSandboxSpec(
    {
      home: '/Users/u',
      userData: '/Users/u/Library/Application Support/ShuviX',
      shuvixHome: '/Users/u/.shuvix',
      uid: 501,
      cliSocket: '/Users/u/.shuvix/cli.sock',
      tmpRoot: '/private/tmp/shuvix-501'
    },
    {
      sessionId: 'sess-1',
      workingDirectory: '/Users/u/proj',
      grantedWrite: [],
      credentialPaths: ['/Users/u/.ssh']
    },
    (p) => p
  )
  if (!built.ok) throw new Error(built.reason)
  const note = explainSandboxDenial({
    spec: built.spec,
    outputTail: 'touch: /Users/u/.shuvix/x: Operation not permitted',
    exitCode: 1,
    offerEscalation: true
  })
  expect(note).not.toBeNull()
  return note!
}

/** 全部文字来源：[标签, 文字] */
function sources(): Array<[string, string]> {
  const bash = new BashTool({ sessionId: 'sess-texts' } as ToolContext)
  const out: Array<[string, string]> = [
    ['bash tool description (sandbox pinned on)', bash.description],
    ['[sandbox] denial note', denialNote()]
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
    for (const name of ['ask-on-command', 'ask-on-write', 'protect-credentials']) {
      out.push([`${name}.${lang}`, policyText(name, lang)])
    }
    out.push([
      `knowledge ${lang}/policy-md.md`,
      readFileSync(join(DESKTOP_DIR, 'resources/knowledge/shuvix', lang, 'policy-md.md'), 'utf8')
    ])
  }
  return out
}

const BANNED: RegExp[] = [
  /personal (folder|dir)/i,
  /ask-on-read/,
  /sandboxRead(Denied|Allowed)/,
  /\.vscode/,
  /ShuviX's (own )?data\b.*(unreadable|cannot read)/i,
  /个人(资料|文件夹)/,
  /個人(用)?フォルダ/
]

const MENTIONS_CREDENTIALS = /credential|凭据|認証情報/i

describe('TX-1 讲沙箱的文字跟着收窄改了口', () => {
  const all = sources()

  it('TX-1 语料齐全：每一处都读到了、都不是空的（bash 描述确实带着受限那一段）', () => {
    expect(all).toHaveLength(2 + LANGS.length * 6)
    for (const [label, text] of all) expect(text.trim(), label).not.toBe('')
    expect(all[0][1]).toContain('confined in a sandbox')
    expect(all[0][1]).toContain('dangerouslyDisableSandbox')
  })

  it.each(BANNED.map((re) => [String(re), re] as const))('TX-1 没有哪一处匹配 %s', (_label, re) => {
    const hits = all.filter(([, text]) => re.test(text)).map(([label]) => label)
    expect(hits).toEqual([])
  })

  it('TX-1 每一处都说到凭据', () => {
    const missing = all.filter(([, text]) => !MENTIONS_CREDENTIALS.test(text)).map(([l]) => l)
    expect(missing).toEqual([])
  })

  it.each(LANGS)(
    'TX-1 ask-on-command（%s）的正文讲围栏：git hooks 与 ShuviX 自己的文件写不了',
    (lang) => {
      const OWN_FILES: Record<(typeof LANGS)[number], string> = {
        en: "ShuviX's own files",
        zh: 'ShuviX 自己的文件',
        ja: 'ShuviX 自身のファイル'
      }
      const text = policyText('ask-on-command', lang)
      expect(text).toContain('.git/hooks')
      expect(text).toContain(OWN_FILES[lang])
    }
  )
})

describe('TX-2 接线', () => {
  it('TX-2 main 启动时把 sessionCredentialPaths 注入给沙箱', () => {
    const source = readFileSync(join(MAIN_DIR, 'index.ts'), 'utf8')
    expect(source).toContain('setSandboxCredentialReader(sessionCredentialPaths)')
  })
})
