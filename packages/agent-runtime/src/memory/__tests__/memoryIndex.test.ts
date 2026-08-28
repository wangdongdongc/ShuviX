/**
 * 项目记忆索引渲染的守护测试。
 *
 * 这份围栏每个会话必付，而它的成败全在几处措辞上 —— 都是散文，改坏了不会有任何编译
 * 或运行期报错。实测（Kimi API，N=20，看模型是否 read 记忆、路径对不对）：
 *
 *   条目标识用 frontmatter 的 name（旧实现）   召回 65%   路径正确  0%
 *   条目标识用 `<slug>.md`                     召回 95%   路径正确 95%
 *   每条再给绝对路径                           召回 90%   —— 不值得那份开销
 *
 *   表头只说「read one at <root>/<file>」      直接命中 15/20 召回
 *   表头加「动手前先对一遍索引」               直接命中 20/20；无关任务仍 19/20 不召回
 *
 * **路径正确率 0% 不是概率问题**：旧实现只把 name 交给模型，而 name 取自 frontmatter、
 * 与文件名会漂（模型写记忆时很自然填一句人话「认证流程的坑」，文件却叫 auth-flow.md），
 * 它于是无从知道 slug —— 再完美的模型也拼不出正确路径。所以「索引里出现的是文件名」
 * 这条必须钉死。
 */
import { describe, it, expect } from 'vitest'
import { parseMemoryFile, type ParsedMemoryFile } from '../memoryFile'
import { renderMemoryIndex } from '../memoryIndex'

const ROOT = '/Users/x/.shuvix/memory/proj'

function mem(
  slug: string,
  frontmatterName: string,
  opts: { recall?: string; pinned?: boolean; updated?: string; body?: string } = {}
): ParsedMemoryFile {
  const lines = ['---', 'shuvix: memory v1', `name: ${frontmatterName}`]
  if (opts.recall) lines.push(`shuvix-memory-recall: ${opts.recall}`)
  if (opts.pinned) lines.push('shuvix-memory-pinned: true')
  if (opts.updated) lines.push(`shuvix-memory-updated: ${opts.updated}`)
  lines.push('---', '', opts.body ?? '正文。')
  return parseMemoryFile(lines.join('\n'), slug) as ParsedMemoryFile
}

describe('slug 与 name 是两回事', () => {
  it('slug 恒等于文件名，不受 frontmatter 影响', () => {
    const m = mem('auth-flow', '认证流程的坑')
    expect(m.slug).toBe('auth-flow')
    expect(m.name).toBe('认证流程的坑')
  })

  it('frontmatter 没写 name 时，name 回落到文件名（slug 仍是文件名）', () => {
    const m = parseMemoryFile(
      '---\nshuvix: memory v1\nshuvix-memory-recall: 何时\n---\n\n正文。',
      'auth-flow'
    ) as ParsedMemoryFile
    expect(m.slug).toBe('auth-flow')
    expect(m.name).toBe('auth-flow')
  })
})

describe('索引里出现的必须是文件名（路径正确率的唯一来源）', () => {
  const m = mem('auth-flow', '认证流程的坑', { recall: '改动登录/鉴权时', updated: '2026-08-01' })

  it('条目用 `<slug>.md` 标识', () => {
    const out = renderMemoryIndex([m], ROOT)
    expect(out).toContain('`auth-flow.md`')
  })

  it('条目里不出现 frontmatter 的 name —— 它会把模型引向不存在的路径', () => {
    // 回归钉：旧实现渲染 name，实测 20/20 次召回全部拼出 <root>/认证流程的坑.md
    const out = renderMemoryIndex([m], ROOT)
    const index = out.slice(out.indexOf('## Index'))
    expect(index).not.toContain('认证流程的坑')
  })

  it('召回条件仍然带出来 —— 那是模型判断该不该打开的唯一依据', () => {
    expect(renderMemoryIndex([m], ROOT)).toContain('改动登录/鉴权时')
  })

  it('常驻记忆的标题也带文件名 —— 更正它同样需要知道文件叫什么', () => {
    const p = mem('always-x', '总是这样', { pinned: true, body: '常驻正文' })
    const out = renderMemoryIndex([p], ROOT)
    expect(out).toContain('`always-x.md`')
    expect(out).toContain('常驻正文')
  })

  it('每条不重复给绝对路径 —— 根路径表头给一次就够（实测更长并不更准）', () => {
    const out = renderMemoryIndex([m, mem('b', 'B', { recall: 'r' })], ROOT)
    const index = out.slice(out.indexOf('## Index'), out.indexOf('## Writing'))
    expect(index).not.toContain(ROOT)
  })
})

describe('表头的召回指令', () => {
  const out = (): string => renderMemoryIndex([mem('a', 'A', { recall: 'r' })], ROOT)

  it('要求动手前先对一遍索引 —— 实测把直接命中从 15/20 拉到 20/20', () => {
    expect(out()).toMatch(/[Bb]efore you start work/)
  })

  it('根路径在表头给出一次', () => {
    expect(out()).toContain(ROOT)
  })

  it('提醒记忆记的是写下时的情况，用前要对照当前代码', () => {
    expect(out()).toMatch(/verify any code detail against the current code/)
  })
})

describe('退化输入', () => {
  it('零条记忆时仍输出写入段 —— 否则记忆库永远无法从空启动', () => {
    const out = renderMemoryIndex([], ROOT)
    expect(out).toContain('## Writing')
    expect(out).toContain(ROOT)
    expect(out).not.toContain('## Index')
  })

  it('没有召回条件时给出占位而不是空尾巴', () => {
    const out = renderMemoryIndex([mem('a', 'A')], ROOT)
    // 只看索引段：表头本身有一行以破折号收尾，别把它算进来
    const index = out.slice(out.indexOf('## Index'), out.indexOf('## Writing'))
    expect(index).toContain('`a.md`')
    expect(index).not.toMatch(/—\s*$/m)
    expect(index).toContain('(no recall condition recorded)')
  })

  it('写入段点明文件名就是后续的寻址方式', () => {
    expect(renderMemoryIndex([], ROOT)).toMatch(/file name IS how the\s*\n?memory is addressed/)
  })
})
