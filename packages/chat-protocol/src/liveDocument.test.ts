/**
 * 协作编辑的落点描述 —— `liveDocument.ts` 的 `describeDocChange`。
 *
 * 编辑器（渲染端）与磁盘回落（主进程 tools/doc.ts）共用这一个函数，告诉 agent 改动落在哪一行、那里
 * 现在是什么样：
 *   - `line` 是**新内容的第一行**：插入常以换行开头（接在锚点之后），跳过开头的那几个换行；
 *   - 上下文从**锚点的上一行**（起点所在行的上一行，不早于第 1 行）起，到新内容末行的下一行止
 *     （不晚于文末），最多 25 行；
 *   - 每行 `<行号>│<原文>`，行号按上下文里最大的行号右对齐补空格；
 *   - `after` 是改动之后的全文，`plan.from` 是起点（改动前后一致）。
 *
 *   DC-1 中间插入一行：上下文是上一行、新行、下一行
 *   DC-2 以 \n\n 开头的段落插入：line 跳过开头两个换行；上下文从锚点的上一行起
 *   DC-3 文首插入：上下文从第 1 行起（没有更早的行）
 *   DC-4 文末插入（\n 开头）：上下文到文末为止
 *   DC-5 只插换行：line 落在最后一个空行；空行也带行号
 *   DC-6 纯删除（insert 为空）：line 是起点所在行
 *   DC-7 长插入：上下文截在 25 行；行号补齐到两位
 *   DC-8 在一行行首插入「X\n」：line 是新行，上下文覆盖下一行
 */
import { describe, expect, it } from 'vitest'
import { describeDocChange } from './liveDocument'

describe('describeDocChange', () => {
  it('DC-1 中间插入一行 → 第 3 行；上下文 2..4', () => {
    expect(describeDocChange('L1\nL2\nNEW\nL4\nL5', { from: 6, insert: 'NEW' })).toEqual({
      line: 3,
      context: '2│L2\n3│NEW\n4│L4'
    })
  })

  it('DC-2 以 \\n\\n 开头的段落：line 跳过开头的换行；上下文从锚点的上一行起，到新段落的下一行止', () => {
    expect(
      describeDocChange('# T\n\npara one\n\nnew para\n\npara two', {
        from: 13,
        insert: '\n\nnew para'
      })
    ).toEqual({ line: 5, context: '2│\n3│para one\n4│\n5│new para\n6│' })
  })

  it('DC-3 文首插入：没有更早的行，上下文从第 1 行起', () => {
    expect(describeDocChange('top\nfirst\nsecond', { from: 0, insert: 'top\n' })).toEqual({
      line: 1,
      context: '1│top\n2│first\n3│second'
    })
  })

  it('DC-4 文末插入：上下文到文末为止（不越界）', () => {
    expect(describeDocChange('a\nb\nc', { from: 3, insert: '\nc' })).toEqual({
      line: 3,
      context: '1│a\n2│b\n3│c'
    })
  })

  it('DC-5 只插换行：line 落在最后一个空行；空行照样带行号', () => {
    expect(describeDocChange('a\n\n', { from: 1, insert: '\n\n' })).toEqual({
      line: 3,
      context: '1│a\n2│\n3│'
    })
  })

  it('DC-6 纯删除（insert 为空）：line 是起点所在行', () => {
    expect(describeDocChange('x\nz', { from: 2, insert: '' })).toEqual({
      line: 2,
      context: '1│x\n2│z'
    })
  })

  it('DC-7 长插入：上下文最多 25 行（8..32），行号右对齐补到两位', () => {
    const before = Array.from({ length: 20 }, (_, i) => `r${i + 1}`).join('\n')
    const inserted = '\n' + Array.from({ length: 40 }, (_, i) => `n${i + 1}`).join('\n')
    const from = before.indexOf('r9') + 'r9'.length
    const after = before.slice(0, from) + inserted + before.slice(from)
    const out = describeDocChange(after, { from, insert: inserted })
    expect(out.line).toBe(10)
    const lines = out.context.split('\n')
    expect(lines).toHaveLength(25)
    expect(lines[0]).toBe(' 8│r8')
    expect(lines[1]).toBe(' 9│r9')
    expect(lines[2]).toBe('10│n1')
    expect(lines[24]).toBe('32│n23')
  })

  it('DC-8 在行首插入「X\\n」：line 是新行；上下文从上一行到被推下去的那一行之后', () => {
    expect(describeDocChange('a\nX\nb\nc', { from: 2, insert: 'X\n' })).toEqual({
      line: 2,
      context: '1│a\n2│X\n3│b\n4│c'
    })
  })
})
