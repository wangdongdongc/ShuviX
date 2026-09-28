/**
 * 设置 → 通用 → 安全里自动审查开关的说明（`settings.autoReviewHint`）点名了审查员规则所在的两份 md ——
 * 侧栏「智能体」里的权限审查员（`permission-reviewer`）与「Hooks」里的自动审查（`auto-review`）。
 * 用户照着这两个名字去侧栏找，名字对不上就是一条死路；而显示名住在 md 里、说明住在语言包里，
 * 改了一边另一边毫无感觉。所以三语逐一对照：说明里必须同时出现那一语言版 md 的 shuvix-displayName。
 *
 * 读法：agent md 经构建期内联读取口（与运行时读的是同一批文件）；hook md 直接读盘（同 builtinHooks.test.ts）。
 * 显示名一律经各自的真解析器取，不手抠 frontmatter。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import { createInlineMdReader } from '../../subagent/builtinAgents/inlineSources'
import { parseAgentDefinitionFile } from '../../agentProfile/definitionFile'
import { parseHookDefinitionFile } from '../hookFile'

const LANGS = { en, zh, ja } as const
type Lang = keyof typeof LANGS

/** 某语言那一版的 md 文件名（en 无后缀） */
const fileFor = (base: string, lang: Lang): string =>
  lang === 'en' ? `${base}.md` : `${base}.${lang}.md`

const readAgentMd = createInlineMdReader()
const readHookMd = (file: string): string =>
  readFileSync(new URL(`../builtinHooks/md/${file}`, import.meta.url), 'utf-8')

function reviewerDisplayName(lang: Lang): string {
  const file = fileFor('permission-reviewer', lang)
  const raw = readAgentMd(file)
  expect(raw, `agent md ${file}`).toBeTypeOf('string')
  const parsed = parseAgentDefinitionFile(raw!, 'permission-reviewer')
  expect(parsed, `agent md ${file} 解析失败`).not.toBeNull()
  return parsed!.displayName
}

function hookDisplayName(lang: Lang): string {
  const file = fileFor('auto-review', lang)
  const parsed = parseHookDefinitionFile(readHookMd(file), 'auto-review')
  expect(parsed, `hook md ${file} 解析失败`).not.toBeNull()
  return parsed!.displayName
}

describe('settings.autoReviewHint 点名的两份 md 与它们的显示名一致', () => {
  it.each(Object.keys(LANGS) as Lang[])(
    'AH-1 %s：说明里同时出现权限审查员与自动审查 hook 的显示名',
    (lang) => {
      const hint = (LANGS[lang] as { settings: { autoReviewHint: string } }).settings.autoReviewHint
      expect(hint.trim()).toBeTruthy()

      const agentName = reviewerDisplayName(lang)
      const hookName = hookDisplayName(lang)
      // 显示名确实是本地化过的（不是回落到机器名）—— 否则下面的对照就是在比 name
      expect(agentName).not.toBe('permission-reviewer')
      expect(hookName).not.toBe('auto-review')

      expect(hint, `${lang} 说明缺权限审查员的显示名「${agentName}」`).toContain(agentName)
      expect(hint, `${lang} 说明缺自动审查 hook 的显示名「${hookName}」`).toContain(hookName)
    }
  )
})
