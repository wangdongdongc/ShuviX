/**
 * Codemode Phase 1 · D. Presentation、摘要与 i18n（CM-UI-01..03）：
 *
 *   - CM-UI-01：`BUILTIN_TOOL_PRESENTATIONS.codemode` 的 labelKey / icon / iconColor / formItems
 *   - CM-UI-02：`buildToolSummary('codemode', args)` 单行、多行前导空行/缩进、48 字符截断、空/缺失/非字符串
 *   - CM-UI-03：`en.json` / `zh.json` / `ja.json` 的 `tool.codemodeLabel` 与 `toolCall.codemodeCalls`（含 `{{count}}`）
 */
import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_PRESENTATIONS } from '../builtinToolPresentations'
import { buildToolSummary } from '../toolSummaries'
import en from '../i18n/locales/en.json'
import zh from '../i18n/locales/zh.json'
import ja from '../i18n/locales/ja.json'

describe('Codemode Phase 1 · D. Presentation、摘要与 i18n', () => {
  it('CM-UI-01 BUILTIN_TOOL_PRESENTATIONS.codemode 声明完整的 labelKey / icon / iconColor / formItems', () => {
    const def = BUILTIN_TOOL_PRESENTATIONS.codemode
    expect(def).toBeDefined()
    expect(def.labelKey).toBe('tool.codemodeLabel')
    expect(def.presentation).toBeDefined()
    expect(def.presentation!.icon).toBe('Code')
    expect(typeof def.presentation!.iconColor).toBe('string')
    expect(def.presentation!.iconColor!.length).toBeGreaterThan(0)
    expect(def.presentation!.formItems).toContainEqual({
      field: 'code',
      renderer: { type: 'code', language: 'javascript' }
    })
  })

  it('CM-UI-02 buildToolSummary("codemode", args) 正确处理单行、多行缩进、超 48 字符截断以及空/非字符串', () => {
    // 单行代码
    expect(buildToolSummary('codemode', { code: 'const x = 1' })).toBe('const x = 1')

    // 带前导空行与缩进的多行代码 → 取首个非空行并 trim
    expect(
      buildToolSummary('codemode', {
        code: '\n   \n    const res = await tools.echo({ text: "hi" })\nreturn res'
      })
    ).toBe('const res = await tools.echo({ text: "hi" })')

    // 恰好 48 字符不截断
    const exact48 = 'a'.repeat(48)
    expect(buildToolSummary('codemode', { code: exact48 })).toBe(exact48)

    // 超 48 字符截断为前 47 字符 + "…"
    const long55 = '0123456789'.repeat(5) + 'abcde'
    const summary = buildToolSummary('codemode', { code: long55 })
    expect(summary).toBe(`${long55.slice(0, 47)}…`)
    expect(summary).toHaveLength(48)

    // 空字符串、仅空白、缺失、非字符串 → undefined
    expect(buildToolSummary('codemode', { code: '' })).toBeUndefined()
    expect(buildToolSummary('codemode', { code: '   \n\t  ' })).toBeUndefined()
    expect(buildToolSummary('codemode', {})).toBeUndefined()
    expect(buildToolSummary('codemode', undefined)).toBeUndefined()
    expect(buildToolSummary('codemode', { code: null })).toBeUndefined()
    expect(buildToolSummary('codemode', { code: { raw: 'x' } })).toBeUndefined()
    expect(buildToolSummary('codemode', { code: ['line1'] })).toBeUndefined()
  })

  it('CM-UI-03 en.json / zh.json / ja.json 均包含非空 tool.codemodeLabel 与带 {{count}} 的 toolCall.codemodeCalls', () => {
    for (const [locale, bundle] of [
      ['en', en],
      ['zh', zh],
      ['ja', ja]
    ] as const) {
      expect(typeof bundle.tool.codemodeLabel, `${locale}.tool.codemodeLabel`).toBe('string')
      expect(
        bundle.tool.codemodeLabel.trim().length,
        `${locale}.tool.codemodeLabel`
      ).toBeGreaterThan(0)
      expect(typeof bundle.toolCall.codemodeCalls, `${locale}.toolCall.codemodeCalls`).toBe(
        'string'
      )
      expect(bundle.toolCall.codemodeCalls, `${locale}.toolCall.codemodeCalls`).toContain(
        '{{count}}'
      )
    }
  })
})
