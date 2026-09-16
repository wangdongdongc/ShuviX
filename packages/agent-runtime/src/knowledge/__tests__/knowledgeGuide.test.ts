/**
 * `<knowledge_bases>` 围栏的正文（围栏本身由 createAgent 加）。
 *
 * 它回答的只有两件事：**这条会话手头有哪几个库、怎么进去**。早先这段是静态的、以「这个项目有
 * 一个知识库」开篇，每个项目会话都得付一整段项目库说教；现在主角是用户自己的库，项目库只是
 * 其中一个名字 —— 所以本文件钉的就是「压到列表 + 三句话」这个形状：
 *   - 一个库都没有 → **返回 null**（整段不注入，零成本），不是空串也不是只剩表头的一段；
 *   - 列表逐库一行，顺序原样（选择的顺序就是宿主给的顺序），不排序不去重；
 *   - 正文**不含条目、不含路径、不含计数** —— 条目怎么进系统提示词是尚未决定的设计，而印出
 *     一条根路径会诱导 agent 直接 `write` 过去，绕开只有 `create` 才担保的元数据形状。
 */
import { describe, it, expect } from 'vitest'
import { renderKnowledgeGuide } from '../knowledgeGuide'

describe('KG-1..3 知识库围栏正文', () => {
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

  it('KG-3 正文只有清单 + 三句话：给入口不给内容', () => {
    const text = renderKnowledgeGuide([{ name: 'notes' }, { name: 'project', label: 'Acme' }])!

    // 入口三件：用哪个工具、可以不点名 base 地搜、什么值得记
    expect(text).toContain('`search`')
    expect(text).toContain('leave `base` out')
    expect(text).toContain('`create`')

    // 不给内容：没有条目文件名、没有条目计数、没有任何路径（印了路径就等于邀请 agent 直接 write）
    expect(text).not.toContain('.md')
    expect(text).not.toContain('/')
    expect(/\d/.test(text), `no counts in: ${text}`).toBe(false)

    // 不再以项目库开篇 —— 它只是清单里可能有的一个名字
    expect(text).not.toContain('Each project has')
    expect(text.startsWith('Knowledge bases this session works with')).toBe(true)
  })
})
