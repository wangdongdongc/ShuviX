/**
 * `mermaidFrameSources` —— ```mermaid 围栏「这一刻拿什么去渲染」的帧候选（纯函数，node 环境）。
 *
 * 渲染器（pele）同步、亚毫秒级，于是流式中也逐帧画；帧是**源码的纯函数**，组件不记「上一张好图」。
 * 这里钉的是候选的形状与顺序（渲染、净化与失败语义在 `mermaidFence.dom.test.ts`）：
 *
 *  - **闭合**（或消息写完了）：只有源码本身 —— 写坏了就是写坏了，不补、不退（MF-1）；
 *  - **开着**：丢掉可能写到一半的最后一行（MF-2 / MF-8），至少两行内容才出帧（MF-4），
 *    每一截按固定顺序补七种尾巴（MF-3），补不出来就再退一行；
 *  - 什么不算「内容」：前置 frontmatter、空行、`%%` 注释（含 `%%{init}%%`）（MF-5 / MF-6）；
 *    以空行 / 注释结尾的那一截与少一行的等价，不单独成为截断点（MF-7）。
 */
import { describe, it, expect } from 'vitest'

import { mermaidFrameSources } from './mermaidFence'

/** 补在每一截末尾的尾巴，与实现里的顺序一致 —— 顺序就是优先级 */
const TAILS = ['', '\nend', '\n}', '\nend\nend', '\n}\n}', '\n}\nend', '\nend\nend\nend']

const frames = (code: string, closed: boolean): string[] => [...mermaidFrameSources(code, closed)]

describe('mermaidFrameSources', () => {
  it('MF-1 闭合：恰好只有源码本身（坏的一行与正常的多行都一样，不补、不退）', () => {
    expect(frames('graph TD; a -->', true)).toEqual(['graph TD; a -->'])
    const ok = 'graph TD\n  a-->b\n  b-->c'
    expect(frames(ok, true)).toEqual([ok])
  })

  it('MF-2 开着：最后一行（可能写到一半）丢掉，第一个候选是它前面那一截', () => {
    const got = frames('graph TD\n  a-->b\n  b-->c[par', false)
    expect(got[0]).toBe('graph TD\n  a-->b')
    expect(got.some((s) => s.includes('c[par'))).toBe(false)
  })

  it('MF-3 开着：每一截按固定顺序补七种尾巴，再退一行，直到不足两行内容', () => {
    const got = frames('graph TD\n a\n b\n c', false)
    const longer = 'graph TD\n a\n b'
    const shorter = 'graph TD\n a'
    expect(got).toEqual([...TAILS.map((t) => longer + t), ...TAILS.map((t) => shorter + t)])
    expect(got).toHaveLength(14)
  })

  it('MF-4 开着、内容不足两行：一个候选都没有', () => {
    expect(frames('graph TD', false)).toEqual([])
    expect(frames('graph TD\n  a-->', false)).toEqual([])
    expect(frames('', false)).toEqual([])
  })

  it('MF-5 frontmatter / 空行 / %% 注释 / %%{init}%% 都不算内容', () => {
    const code = '---\ntitle: X\n---\n%%{init: {}}%%\n\ngraph TD\n%% c\n  a-->b\nx'
    const got = frames(code, false)
    expect(got.length).toBeGreaterThan(0)
    expect(got[0].endsWith('  a-->b')).toBe(true)
    // 第一个候选就是「到 a-->b 为止」的整截（前面的 frontmatter / 注释原样带着）
    expect(got[0]).toBe('---\ntitle: X\n---\n%%{init: {}}%%\n\ngraph TD\n%% c\n  a-->b')
  })

  it('MF-6 frontmatter 还没写完：不算有内容，一个候选都没有', () => {
    expect(frames('---\ntitle: X\ngraph TD\n a-->b\n', false)).toEqual([])
  })

  it('MF-7 结尾的空行 / %% 行不单独成为截断点：恰好 7 个候选，每一截都止于 a-->b', () => {
    const got = frames('graph TD\n a-->b\n\n%% note\n part', false)
    // 没有一截止于空行（'graph TD\n a-->b\n'）或注释行（'…\n\n%% note'）
    expect(got).toEqual(TAILS.map((t) => 'graph TD\n a-->b' + t))
  })

  it('MF-8 源码以换行结尾：最后「一行」是空串，丢掉它之后第一个候选就是完整内容', () => {
    expect(frames('graph TD\n a-->b\n', false)[0]).toBe('graph TD\n a-->b')
  })
})
