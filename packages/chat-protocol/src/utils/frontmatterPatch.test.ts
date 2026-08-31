/**
 * patchFrontmatterScalar —— 设置页「门控模型选择器」的唯一写入原语（A1）。
 *
 * 它对 ~/.shuvix/agents/bot-intent.md 这样的**既有用户文件**做单键改写，所以这组测试
 * 钉的是「除目标行外逐字节不动」这条纪律：它一旦破坏注释/键序/正文，用户手编的覆盖
 * 档案就会在一次改模型之后面目全非。
 *
 * **钉现状，不改实现**（A 组约定）。读实现时发现的两处隐患记录在此，供后续裁决：
 *  - `new RegExp(\`^${key}\\s*:\`)` 把 key 原样拼进正则 —— key 含正则元字符时会错配。
 *    现有调用方只传 'shuvix-model'，暂无触发面；
 *  - frontmatter 键重复时只动第一处（见 A9 的注释）。
 */
import { describe, it, expect } from 'vitest'
import { patchFrontmatterScalar } from './frontmatterPatch'

/** 一份典型的 bot-intent 覆盖档案（含注释与正文 —— 它们必须原样活过改写） */
const DOC = [
  '---',
  'shuvix: agent v1',
  'name: bot-intent',
  'description: gate stage',
  'shuvix-model: openai/gpt-old',
  'shuvix-dispatch-only: true',
  '---',
  '',
  'BODY LINE ONE.',
  'BODY LINE TWO.'
].join('\n')

describe('patchFrontmatterScalar', () => {
  it('A1 改既有键：仅该行变，其余逐字节不变', () => {
    const out = patchFrontmatterScalar(DOC, 'shuvix-model', 'openai/gpt-4.1')
    expect(out).toBe(DOC.replace('shuvix-model: openai/gpt-old', 'shuvix-model: openai/gpt-4.1'))
    // 行数不变（原位替换，不是删了再插）
    expect(out.split('\n')).toHaveLength(DOC.split('\n').length)
  })

  it('A2 冒号前带空格的 `key : old` 命中，并替换为规范形 `key: new`', () => {
    const text = ['---', 'name: x', 'shuvix-model : old-ref', '---', 'BODY.'].join('\n')
    expect(patchFrontmatterScalar(text, 'shuvix-model', 'new-ref')).toBe(
      ['---', 'name: x', 'shuvix-model: new-ref', '---', 'BODY.'].join('\n')
    )
  })

  it('A3 近似前缀键 shuvix-model-extra 不误伤 —— 插入新行而不是改它', () => {
    const text = ['---', 'name: x', 'shuvix-model-extra: keep-me', '---', 'BODY.'].join('\n')
    const out = patchFrontmatterScalar(text, 'shuvix-model', 'v1')
    // 近似键原样保留
    expect(out).toContain('shuvix-model-extra: keep-me')
    // 目标键作为新行插进闭合 --- 之前
    expect(out).toBe(
      ['---', 'name: x', 'shuvix-model-extra: keep-me', 'shuvix-model: v1', '---', 'BODY.'].join(
        '\n'
      )
    )
  })

  it('A4 键缺失 → 恰在闭合 --- 前一行插入，body 一字不动', () => {
    const text = ['---', 'name: x', '---', '', 'BODY KEEPS EXACTLY.', ''].join('\n')
    expect(patchFrontmatterScalar(text, 'shuvix-model', 'p/m')).toBe(
      ['---', 'name: x', 'shuvix-model: p/m', '---', '', 'BODY KEEPS EXACTLY.', ''].join('\n')
    )
  })

  it('A5 删除既有键：该行整行消失，其余不动', () => {
    expect(patchFrontmatterScalar(DOC, 'shuvix-model', null)).toBe(
      DOC.split('\n')
        .filter((l) => l !== 'shuvix-model: openai/gpt-old')
        .join('\n')
    )
  })

  it('A5b 删除不存在的键 → 原文返回', () => {
    const text = ['---', 'name: x', '---', 'BODY.'].join('\n')
    expect(patchFrontmatterScalar(text, 'shuvix-model', null)).toBe(text)
  })

  it('A6 无 frontmatter（首行非 ---）→ set / delete 均原样返回', () => {
    const text = 'just prose\n---\nnot frontmatter\n---\n'
    expect(patchFrontmatterScalar(text, 'shuvix-model', 'v')).toBe(text)
    expect(patchFrontmatterScalar(text, 'shuvix-model', null)).toBe(text)
  })

  it('A6b 首行是空行、--- 在第二行 → 不算 frontmatter，原样返回', () => {
    // 判定只认第 0 行（与 markdownFrontmatter 的严格口径同向）：领头空行即散文
    const text = '\n---\nshuvix-model: old\n---\nBODY.'
    expect(patchFrontmatterScalar(text, 'shuvix-model', 'new')).toBe(text)
    expect(patchFrontmatterScalar(text, 'shuvix-model', null)).toBe(text)
  })

  it('A7 只有开头 --- 没有闭合 → 原样返回（不猜块边界）', () => {
    const text = '---\nname: x\nshuvix-model: old\nBODY WITHOUT CLOSE.'
    expect(patchFrontmatterScalar(text, 'shuvix-model', 'new')).toBe(text)
    expect(patchFrontmatterScalar(text, 'shuvix-model', null)).toBe(text)
  })

  it('A8 空 frontmatter 块 → 插入恰落在两条 --- 之间', () => {
    expect(patchFrontmatterScalar('---\n---\nBODY.', 'shuvix-model', 'p/m')).toBe(
      '---\nshuvix-model: p/m\n---\nBODY.'
    )
  })

  it('A9 键重复两次：set 改第一处留第二处；delete 删第一处留第二处（钉现状）', () => {
    // ⚠️ 钉的是现状，不是背书：YAML 语义下重复键以**后者**为准（yaml 库甚至直接报错），
    // 而本函数只动**第一处** —— set 之后生效值仍是第二处的旧值，delete 之后第二处「复活」。
    // 真实调用链里这种文件本就过不了 parseAgentDefinitionFile，风险面有限；若将来
    // 改成「动最后一处 / 全部」，这条用例就是要一起改的那条。
    const text = ['---', 'shuvix-model: first', 'name: x', 'shuvix-model: second', '---', 'B'].join(
      '\n'
    )
    expect(patchFrontmatterScalar(text, 'shuvix-model', 'patched')).toBe(
      ['---', 'shuvix-model: patched', 'name: x', 'shuvix-model: second', '---', 'B'].join('\n')
    )
    expect(patchFrontmatterScalar(text, 'shuvix-model', null)).toBe(
      ['---', 'name: x', 'shuvix-model: second', '---', 'B'].join('\n')
    )
  })

  it('A10 正文里的同名键与正文 ---（hr）不受影响（i < close 的边界）', () => {
    const text = [
      '---',
      'name: x',
      'shuvix-model: fm-value',
      '---',
      '',
      'shuvix-model: body-value',
      '',
      '---',
      '',
      'after the hr.'
    ].join('\n')
    const out = patchFrontmatterScalar(text, 'shuvix-model', 'patched')
    expect(out).toBe(
      [
        '---',
        'name: x',
        'shuvix-model: patched',
        '---',
        '',
        'shuvix-model: body-value',
        '',
        '---',
        '',
        'after the hr.'
      ].join('\n')
    )
    // 删除同理只动 frontmatter 里那行
    expect(patchFrontmatterScalar(text, 'shuvix-model', null)).toBe(
      text
        .split('\n')
        .filter((l) => l !== 'shuvix-model: fm-value')
        .join('\n')
    )
  })

  it('A11 缩进的嵌套同名键不命中（^ 锚定）→ 插入顶层行', () => {
    const text = [
      '---',
      'shuvix-bot-agents:',
      '  intent: bot-intent',
      '  model: nested-keep',
      '---',
      'B'
    ].join('\n')
    const out = patchFrontmatterScalar(text, 'model', 'top-level')
    expect(out).toContain('  model: nested-keep')
    expect(out).toBe(
      [
        '---',
        'shuvix-bot-agents:',
        '  intent: bot-intent',
        '  model: nested-keep',
        'model: top-level',
        '---',
        'B'
      ].join('\n')
    )
  })

  it('A12 值原样写入：`key: value` 单空格，无引号无转义', () => {
    const out = patchFrontmatterScalar('---\n---\n', 'shuvix-model', 'openai/gpt-4.1')
    expect(out.split('\n')[1]).toBe('shuvix-model: openai/gpt-4.1')
  })

  it('A13 CRLF：`---\\r\\n` 与 `key: v\\r` 都可识别；改写行落 LF（钉混合行尾现状）', () => {
    const text = '---\r\nname: x\r\nshuvix-model: old\r\n---\r\nBODY\r\n'
    // 识别：CRLF 的 --- 与键行都命中（trim / \s* 吃掉 \r）
    const out = patchFrontmatterScalar(text, 'shuvix-model', 'openai/gpt-4.1')
    // ⚠️ 现状：替换行是重铸的 `key: value`，**不带 \r** —— 输出因此是混合行尾。
    // md 解析两种行尾都认，这里如实钉住，若将来改为保留原行尾需同步改此断言
    expect(out).toBe('---\r\nname: x\r\nshuvix-model: openai/gpt-4.1\n---\r\nBODY\r\n')
    // 删除：整行（连同它的 \r）消失
    expect(patchFrontmatterScalar(text, 'shuvix-model', null)).toBe(
      '---\r\nname: x\r\n---\r\nBODY\r\n'
    )
    // 插入：新行同样是 LF 尾（与替换同一条纪律）
    expect(patchFrontmatterScalar('---\r\nname: x\r\n---\r\nB\r\n', 'shuvix-model', 'm')).toBe(
      '---\r\nname: x\r\nshuvix-model: m\n---\r\nB\r\n'
    )
  })
})
