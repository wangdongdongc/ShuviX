/**
 * `<knowledge_bases>` 围栏的正文（围栏本身由 createAgent 加）。
 *
 * 它回答的只有两件事：**这条会话手头有哪几个库、怎么进去**。早先这段是静态的、以「这个项目有
 * 一个知识库」开篇，每个项目会话都得付一整段项目库说教；现在主角是用户自己的库，项目库只是
 * 其中一个名字 —— 所以本文件钉的就是「压到列表 + 三句话」这个形状：
 *   - 一个库都没有 → **返回 null**（整段不注入，零成本），不是空串也不是只剩表头的一段；
 *   - 列表逐库一行，顺序原样（选择的顺序就是宿主给的顺序），不排序不去重；
 *   - 正文**不含条目、不含计数** —— 条目怎么进系统提示词是尚未决定的设计；路径只有宿主给的
 *     库目录（条目由 agent 直接 `write` 进库再 `submit`，印目录正是为了让它写得进去）；
 *   - label 原样印出，渲染器**不认识任何一种库** —— 「只读的内置库」是宿主那一侧的概念，
 *     到这里只剩一个名字加一句 label，所以这里没有、也不该有按名字特判的分支。
 */
import { describe, it, expect } from 'vitest'
import { renderKnowledgeGuide } from '../knowledgeGuide'

describe('KG-1..4 知识库围栏正文', () => {
  it('KG-1 一个库都没有 → null（不是空串、不是只有表头的一段）', () => {
    // 空串会被 createAgent 的 trim 判空而同样不注入，但 null 是契约里那一个 —— 「整段不存在」
    expect(renderKnowledgeGuide([])).toBeNull()
  })

  it('KG-2 逐库一行 `- <name> — <label>`；没有 label 只印名字；顺序原样，不排序不去重', () => {
    const text = renderKnowledgeGuide([
      { name: '读书笔记' },
      { name: 'project', label: 'Acme Corp' },
      { name: 'notes', label: 'notes' }
    ])!
    const lines = text.split('\n').filter((line) => line.startsWith('- '))
    expect(lines).toEqual(['- 读书笔记', '- project — Acme Corp', '- notes — notes'])

    // 空串 label 与缺省同义：不印一个吊在后面的破折号
    expect(renderKnowledgeGuide([{ name: 'notes', label: '' }])).toContain('- notes\n')
    expect(renderKnowledgeGuide([{ name: 'notes', label: '' }])).not.toContain('notes —')

    // 顺序即宿主给的顺序（= 用户选择的顺序）；重名也不合并 —— 归一是解析那一侧的事
    const raw = renderKnowledgeGuide([{ name: 'b' }, { name: 'a' }, { name: 'b' }])!
    expect(raw.split('\n').filter((line) => line.startsWith('- '))).toEqual(['- b', '- a', '- b'])
  })

  it('KG-3 正文只有清单 + 几句话：给入口不给内容', () => {
    const text = renderKnowledgeGuide([{ name: 'notes' }, { name: 'project', label: 'Acme' }])!

    // 入口：用哪个工具、什么时候搜、什么值得记、记完提交
    expect(text).toContain('`search`')
    expect(text).toContain('submit')
    expect(text).not.toContain('`create`')
    // 「留空 base 搜全部」是怎么用，归工具描述（KT-12 钉在那边），围栏不再重复付一遍
    expect(text).not.toContain('`base` out')

    // 不给内容：没有条目文件名、没有条目计数；宿主没给目录时也没有任何路径
    expect(text).not.toContain('.md')
    expect(text).not.toContain('/')
    expect(/\d/.test(text), `no counts in: ${text}`).toBe(false)

    // 不再以项目库开篇 —— 它只是清单里可能有的一个名字
    expect(text).not.toContain('Each project has')
    expect(text.startsWith('Knowledge bases this session works with')).toBe(true)
  })

  it('KG-4 label 原样印在 `- <名> — <label>` 里，顺序原样；渲染器不认识「内置」这回事 —— 宿主给什么印什么', () => {
    // 一句完全普通的 label：它恰好在说「这个库是只读的说明书」，但对渲染器而言就是一串字
    const LABEL = 'read-only reference: how ShuviX files are written and where they live'
    const lines = (bases: Parameters<typeof renderKnowledgeGuide>[0]): string[] =>
      renderKnowledgeGuide(bases)!
        .split('\n')
        .filter((line) => line.startsWith('- '))

    // 带 label 的排在最前、没有 label 的夹在中间：字母序、「有 label 的靠后」之类的重排都会露馅
    expect(
      lines([
        { name: 'handbook', label: LABEL },
        { name: '读书笔记' },
        { name: 'project', label: 'Acme Corp' }
      ])
    ).toEqual([`- handbook — ${LABEL}`, '- 读书笔记', '- project — Acme Corp'])

    // 同一句 label 换个名字，行只差名字那一段 —— 没有按名字走的分支
    expect(lines([{ name: 'shuvix', label: LABEL }])).toEqual([`- shuvix — ${LABEL}`])
    // 反过来也一样：名字叫 shuvix 而宿主没给 label，就只有一个光名字，不自己补一句「内置 / 只读」
    expect(lines([{ name: 'shuvix' }])).toEqual(['- shuvix'])
    expect(renderKnowledgeGuide([{ name: 'shuvix' }])).not.toContain('read-only')
  })
})

/**
 * 带目录（2026-10-12）：条目由 agent 直接 `write` 进库再 `submit`，所以围栏把宿主给的库目录印在列表行上，
 * 省一次 `bases`。目录只出现在 `- ` 列表行里 —— 正文仍是「给入口不给内容」，KG-3 那组「无路径、无计数」
 * 的断言收窄到正文照样成立（项目库目录里有 uuid 的数字与斜杠）。
 */
describe('KG-5..8 列表行带库目录', () => {
  const listLines = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('- '))

  it('KG-5 `- <name> — <label> — <dir>`；空 label 不留吊着的破折号', () => {
    const text = renderKnowledgeGuide([
      { name: 'project', label: 'Acme', dir: '/kb/projects/p1' },
      { name: 'notes', dir: '/u/notes' },
      { name: 'x', label: '', dir: '/u/x' }
    ])!
    expect(listLines(text)).toEqual([
      '- project — Acme — /kb/projects/p1',
      '- notes — /u/notes',
      '- x — /u/x'
    ])
  })

  it('KG-6 dir 为空串或缺省：不印目录，也不多出一个 ` — `', () => {
    const text = renderKnowledgeGuide([
      { name: 'a', dir: '' },
      { name: 'b', label: 'B', dir: '' },
      { name: 'c', label: 'C' }
    ])!
    expect(listLines(text)).toEqual(['- a', '- b — B', '- c — C'])
  })

  it('KG-7 带目录时正文（非列表行）仍无路径、无数字、无 .md；讲 submit，不讲 `create`', () => {
    const text = renderKnowledgeGuide([
      {
        name: 'project',
        label: 'Acme',
        dir: '/kb/projects/0199a2b3-7c4d-7e5f-8a9b-0c1d2e3f4a5b'
      },
      { name: 'notes', dir: '/Users/me/.shuvix/knowledge/notes' }
    ])!
    const body = text
      .split('\n')
      .filter((l) => !l.startsWith('- '))
      .join('\n')
    expect(body).not.toContain('/')
    expect(/\d/.test(body), `no digits in: ${body}`).toBe(false)
    expect(body).not.toContain('.md')
    expect(body).toContain('submit')
    expect(body).not.toContain('`create`')
    // 目录确实印出来了：守卫收窄之后不是因为目录根本没出现才通过
    expect(text).toContain('/kb/projects/0199a2b3-7c4d-7e5f-8a9b-0c1d2e3f4a5b')
  })

  it('KG-8 目录原样印出：Windows 反斜杠、空格、中文一字不改', () => {
    const dir = 'C:\\Users\\张 三\\.shuvix\\knowledge\\读书笔记'
    expect(listLines(renderKnowledgeGuide([{ name: '读书笔记', dir }])!)).toEqual([
      `- 读书笔记 — ${dir}`
    ])
  })
})
