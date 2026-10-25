/**
 * 日报的纯函数 —— 文件名规则、模板、摘录、会话链接。
 *
 * 文件名就是身份：认错一个（模板、`.partial` 临时文件、不存在的日子），日历上就会点出一个不该有的点，
 * 或打开一份不是日报的文件。摘录是日历里那一行：模板占位、标题、注释都不该出现在里面，
 * 否则「写了没有」一眼看不出来。
 */
import { describe, expect, it } from 'vitest'
import {
  dailyExcerpt,
  dayOfDailyFile,
  defaultDailyTemplate,
  isDayKey,
  linkText,
  localDayKey,
  parseSessionLink,
  sessionLink
} from './dailyNotes'
import { detectShuvixMarker } from './shuvixMdContract'

const TEMPLATE = defaultDailyTemplate({ done: '完成', next: '接下来', followUp: '待跟进' })

describe('日报文件名与日期', () => {
  it('DN-1 isDayKey 只认真实存在的日子', () => {
    expect(isDayKey('2026-10-22')).toBe(true)
    expect(isDayKey('2024-02-29')).toBe(true)
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-1-2', '20261022', '', 'x']) {
      expect(isDayKey(bad), bad).toBe(false)
    }
  })

  it('DN-2 dayOfDailyFile：只有 `YYYY-MM-DD.md` 是日报；模板、临时文件、别的 md 都不是', () => {
    expect(dayOfDailyFile('2026-10-22.md')).toBe('2026-10-22')
    for (const name of [
      '_template.md',
      '2026-10-22.md.partial',
      '.2026-10-22.md.123.tmp',
      '2026-10-22.MD.bak',
      '2026-02-30.md',
      'notes.md',
      '2026-10-22'
    ]) {
      expect(dayOfDailyFile(name), name).toBeNull()
    }
  })

  it('DN-3 localDayKey 按本地时区取日', () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(localDayKey(new Date(2026, 9, 22, 0, 1))).toBe('2026-10-22')
  })
})

describe('模板与摘录', () => {
  it('DN-4 内置模板带 `shuvix: daily v1` 自述行与三段，每段留一个空项', () => {
    expect(detectShuvixMarker(TEMPLATE)).toEqual({ type: 'daily', version: '1' })
    expect(TEMPLATE).toContain('## 完成\n\n- \n')
    expect(TEMPLATE).toContain('## 接下来\n\n- [ ] \n')
    expect(TEMPLATE).toContain('## 待跟进\n\n- \n')
  })

  it('DN-5 只有模板时摘录为空串（日历显示「还没写内容」）', () => {
    expect(dailyExcerpt(TEMPLATE)).toBe('')
  })

  it('DN-6 摘录去掉标题、空项、注释与列表符号，链接只留文字，逐条以 · 相连', () => {
    const source = [
      '---',
      'shuvix: daily v1',
      '---',
      '',
      '## 完成',
      '',
      '- 修好了 **日历** 的圆点',
      '- [日报设计](shuvix://session/abc#e1)',
      '- ',
      '<!-- 写给自己的提示',
      '不该出现 -->',
      '## 接下来',
      '- [ ] 写测试',
      '- [x] 发版',
      '1. 第一条'
    ].join('\n')
    expect(dailyExcerpt(source)).toBe('修好了 日历 的圆点 · 日报设计 · 写测试 · 发版 · 第一条')
  })

  it('DN-7 摘录超长时截断并加省略号', () => {
    const source = `## 完成\n\n- ${'字'.repeat(300)}\n`
    const excerpt = dailyExcerpt(source, 20)
    expect(excerpt.length).toBe(20)
    expect(excerpt.endsWith('…')).toBe(true)
  })
})

describe('会话链接', () => {
  it('DN-13 sessionLink / parseSessionLink 往返；带不带 entryId 都认', () => {
    const id = '01923f6e-5b7a-7c3d-8e9f-0a1b2c3d4e5f'
    expect(sessionLink(id)).toBe(`shuvix://session/${id}`)
    expect(parseSessionLink(sessionLink(id))).toEqual({ sessionId: id })
    expect(parseSessionLink(sessionLink(id, 'e-42'))).toEqual({ sessionId: id, entryId: 'e-42' })
    expect(sessionLink(id, null)).toBe(`shuvix://session/${id}`)
  })

  it('DN-14 parseSessionLink 不认别的链接', () => {
    for (const url of [
      'https://example.com',
      'shuvix://settings',
      'shuvix://session/',
      'shuvix://session/a/b',
      'shuvix://project/abc',
      'file:///tmp/x.md'
    ]) {
      expect(parseSessionLink(url), url).toBeNull()
    }
  })

  it('DN-16 linkText 转义方括号、压掉换行', () => {
    expect(linkText(' 修 [bug]\n 第二行 ')).toBe('修 \\[bug\\] 第二行')
  })
})
