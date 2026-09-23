/**
 * 协作编辑的纯函数（docOps）—— 定位、流式参数、给 agent 的「用户改了什么」、外部写盘的三方合并。
 *
 * 契约（chat-protocol liveDocument.ts + docOps.ts 的文件头）：
 *   - 定位必须**恰好一处**：重叠的出现也算（「aa」在「aaa」里是两处）；0 处的错误要把 agent 引回
 *     doc_read，多处的错误报出数目（≥10 只说「10 or more」）；
 *   - 半截的参数 JSON 只认**顶层**键的字符串值，转义按 JSON 规则解，还没到齐的转义先丢掉；
 *   - 用户改动的 diff 只有 hunk（没有文件头、没有「\ No newline」），太长截断并说明；
 *   - 三方合并：外部改动与用户的某处改动**重叠或紧挨着**就整段丢掉（用户的版本赢），其余映射过
 *     用户的改动后落下 —— 两边改成一样时不会做两遍。
 *
 *   D1 occurrences：重叠计数、空 needle、limit
 *   D2 planDocChange(edit)：唯一 / 0 处（点名 doc_read）/ 2 处 / ≥10 处 / 空 find / 空 replace 可以
 *   D3 planDocChange(insert)：after / before / 文末；两个都给 → 错；锚点不唯一 → 错
 *   D4 partialJsonString：半截 / 完整；转义；代理对；半截转义丢掉；只认顶层键；非字符串值；
 *      冒号两边的空白；嵌套里的假键之后的真键
 *   D5 userChangesPatch：相同 → undefined；hunk 头、无文件头；「\ No newline」丢掉；超长截断
 *   D6 diffToChanges 两种粒度的往返（空↔文本、CJK、emoji、相邻的删 + 增）
 *   D7 mergeExternalChange：见上面第四条
 */
import { describe, expect, it } from 'vitest'
import { ChangeSet, Text } from '@codemirror/state'
import {
  diffToChanges,
  mergeExternalChange,
  occurrences,
  partialJsonString,
  planDocChange,
  userChangesPatch
} from '../docOps'

const edit = (find: string, replace: string): Parameters<typeof planDocChange>[1] => ({
  kind: 'edit',
  toolCallId: 'tc',
  find,
  replace
})

const insert = (
  text: string,
  anchors: { after?: string; before?: string } = {}
): Parameters<typeof planDocChange>[1] => ({ kind: 'insert', toolCallId: 'tc', text, ...anchors })

const doc = (s: string): Text => Text.of(s.split('\n'))

/** 把一份改动计划落到文本上 */
function applyPlan(src: string, plan: ReturnType<typeof planDocChange>): string {
  if (!plan.ok) throw new Error(plan.error)
  return src.slice(0, plan.from) + plan.insert + src.slice(plan.to)
}

describe('D1 occurrences', () => {
  it('重叠的出现也算：aa 在 aaa 里是 [0, 1]', () => {
    expect(occurrences('aaa', 'aa')).toEqual([0, 1])
  })

  it('空 needle → []（不是每个位置都算一处）', () => {
    expect(occurrences('abc', '')).toEqual([])
  })

  it('limit 截住：aaaa 里找 a、limit 2 → [0, 1]；缺省 limit 10', () => {
    expect(occurrences('aaaa', 'a', 2)).toEqual([0, 1])
    expect(occurrences('a'.repeat(30), 'a')).toHaveLength(10)
  })

  it('找不到 → []', () => {
    expect(occurrences('abc', 'x')).toEqual([])
  })
})

describe('D2 planDocChange —— doc_edit', () => {
  const text = '# Title\n\nalpha beta\n\ngamma\n'

  it('唯一 → 范围就是 find 所在，insert 是 replace', () => {
    const plan = planDocChange(text, edit('alpha beta', 'ALPHA'))
    expect(plan).toEqual({ ok: true, from: 9, to: 19, insert: 'ALPHA' })
    expect(applyPlan(text, plan)).toBe('# Title\n\nALPHA\n\ngamma\n')
  })

  it('0 处 → 错误说对不上、并点名 doc_read', () => {
    const plan = planDocChange(text, edit('delta', 'x'))
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toContain('does not match')
    expect(plan.error).toContain('doc_read')
  })

  it('2 处 → 「matches 2 places」', () => {
    const plan = planDocChange('one x two x', edit('x', 'y'))
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.error).toContain('matches 2 places')
  })

  it('≥10 处 → 「10 or more」（不数到底）', () => {
    for (const n of [10, 25]) {
      const plan = planDocChange('ab '.repeat(n), edit('ab', 'x'))
      expect(plan.ok).toBe(false)
      if (!plan.ok) expect(plan.error).toContain('matches 10 or more places')
    }
    const nine = planDocChange('ab '.repeat(9), edit('ab', 'x'))
    expect(nine.ok).toBe(false)
    if (!nine.ok) expect(nine.error).toContain('matches 9 places')
  })

  it('重叠算多处：aa 在 aaa 里不唯一', () => {
    const plan = planDocChange('aaa', edit('aa', 'b'))
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.error).toContain('matches 2 places')
  })

  it('空 find → 错误', () => {
    const plan = planDocChange(text, edit('', 'x'))
    expect(plan).toEqual({ ok: false, error: '`find` is empty.' })
  })

  it('空 replace 可以（= 删掉那一段）', () => {
    const plan = planDocChange(text, edit('alpha ', ''))
    expect(plan).toEqual({ ok: true, from: 9, to: 15, insert: '' })
    expect(applyPlan(text, plan)).toBe('# Title\n\nbeta\n\ngamma\n')
  })
})

describe('D3 planDocChange —— doc_insert', () => {
  const text = 'head\n\nmiddle\n\ntail'

  it('after：紧跟在锚点之后', () => {
    const plan = planDocChange(text, insert('\n\nNEW', { after: 'middle' }))
    expect(plan).toEqual({ ok: true, from: 12, to: 12, insert: '\n\nNEW' })
    expect(applyPlan(text, plan)).toBe('head\n\nmiddle\n\nNEW\n\ntail')
  })

  it('before：紧挨在锚点之前', () => {
    const plan = planDocChange(text, insert('NEW\n\n', { before: 'middle' }))
    expect(plan).toEqual({ ok: true, from: 6, to: 6, insert: 'NEW\n\n' })
    expect(applyPlan(text, plan)).toBe('head\n\nNEW\n\nmiddle\n\ntail')
  })

  it('都不给 → 文末', () => {
    const plan = planDocChange(text, insert('\nEND'))
    expect(plan).toEqual({ ok: true, from: text.length, to: text.length, insert: '\nEND' })
  })

  it('after 与 before 都给 → 错误', () => {
    const plan = planDocChange(text, insert('x', { after: 'head', before: 'tail' }))
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.error).toContain('not both')
  })

  it('锚点不唯一 → 错误（报出数目）；锚点不存在 → 对不上', () => {
    const twice = planDocChange('a\n\na\n', insert('x', { after: 'a' }))
    expect(twice.ok).toBe(false)
    if (!twice.ok) expect(twice.error).toContain('`after` matches 2 places')

    const none = planDocChange(text, insert('x', { before: 'nowhere' }))
    expect(none.ok).toBe(false)
    if (!none.ok) {
      expect(none.error).toContain('`before` does not match')
      expect(none.error).toContain('doc_read')
    }
  })
})

describe('D4 partialJsonString', () => {
  it('半截的值 → complete false；闭合了 → complete true', () => {
    expect(partialJsonString('{"find": "abc', 'find')).toEqual({ value: 'abc', complete: false })
    expect(partialJsonString('{"find": "abc"', 'find')).toEqual({ value: 'abc', complete: true })
    expect(partialJsonString('{"find": "abc", "replace": "x"}', 'find')).toEqual({
      value: 'abc',
      complete: true
    })
    // 值刚开头（只有起始引号）也算出现过
    expect(partialJsonString('{"find": "', 'find')).toEqual({ value: '', complete: false })
  })

  it('还没出现过这个键 → undefined（键写了一半也算没出现）', () => {
    expect(partialJsonString('{"find": "a", "repl', 'replace')).toBeUndefined()
    expect(partialJsonString('{"find"', 'find')).toBeUndefined()
    expect(partialJsonString('', 'find')).toBeUndefined()
  })

  it('转义按 JSON 解：\\n \\" \\\\ \\/ \\u00e9', () => {
    const json = JSON.stringify({ find: 'a\nb"c\\d/eé\tf' }).replace('/', '\\/')
    // JSON.stringify 不转义 / 和 é：手写一份带 \/ 与 \u00e9 的
    const handWritten = '{"find": "a\\nb\\"c\\\\d\\/e\\u00e9\\tf"}'
    expect(partialJsonString(json, 'find')).toEqual({ value: 'a\nb"c\\d/eé\tf', complete: true })
    expect(partialJsonString(handWritten, 'find')).toEqual({
      value: 'a\nb"c\\d/eé\tf',
      complete: true
    })
  })

  it('代理对（\\ud83d\\ude00）拼回一个 emoji', () => {
    expect(partialJsonString('{"text": "x\\ud83d\\ude00y"}', 'text')).toEqual({
      value: 'x😀y',
      complete: true
    })
  })

  it('末尾一个孤零零的 \\ / 截断的 \\u → 丢掉那一截，仍是半截', () => {
    expect(partialJsonString('{"find": "abc\\', 'find')).toEqual({
      value: 'abc',
      complete: false
    })
    for (const cut of ['\\u', '\\u0', '\\u00', '\\u00e']) {
      expect(partialJsonString(`{"find": "abc${cut}`, 'find'), cut).toEqual({
        value: 'abc',
        complete: false
      })
    }
    // 下一次增量补齐之后就解出来了
    expect(partialJsonString('{"find": "abc\\u00e9', 'find')).toEqual({
      value: 'abcé',
      complete: false
    })
  })

  it('只认顶层键：出现在别的字符串值里、或嵌套对象里 → undefined', () => {
    const inValue = JSON.stringify({ replace: 'say "find": "x" here' })
    expect(partialJsonString(inValue, 'find')).toBeUndefined()
    expect(partialJsonString('{"meta": {"find": "x"}}', 'find')).toBeUndefined()
    expect(partialJsonString('{"list": [{"find": "x"}]}', 'find')).toBeUndefined()
  })

  it('非字符串值 → undefined', () => {
    expect(partialJsonString('{"find": 42}', 'find')).toBeUndefined()
    expect(partialJsonString('{"find": null}', 'find')).toBeUndefined()
    expect(partialJsonString('{"find": ["x"]}', 'find')).toBeUndefined()
  })

  it('冒号两边的空白（含换行）', () => {
    expect(partialJsonString('{"find"  :   "x"}', 'find')).toEqual({ value: 'x', complete: true })
    expect(partialJsonString('{\n  "find"\n:\n"x"\n}', 'find')).toEqual({
      value: 'x',
      complete: true
    })
  })

  it('前面有假键（嵌套里 / 字符串值里），后面的真键赢', () => {
    expect(partialJsonString('{"meta": {"find": "fake"}, "find": "real"}', 'find')).toEqual({
      value: 'real',
      complete: true
    })
    const both = `{"replace": ${JSON.stringify('has "find": "fake" inside')}, "find": "real"`
    expect(partialJsonString(both, 'find')).toEqual({ value: 'real', complete: true })
    // 前一个值以转义的反斜杠结尾：字符串在那里正常闭合，后面的键是顶层键
    expect(partialJsonString('{"after": "C:\\\\", "find": "y"}', 'find')).toEqual({
      value: 'y',
      complete: true
    })
  })
})

describe('D5 userChangesPatch', () => {
  it('没有改动 → undefined', () => {
    expect(userChangesPatch('same\ntext\n', 'same\ntext\n')).toBeUndefined()
  })

  it('统一 diff 的 hunk：有 @@ 头、有 +/- 行，没有文件头', () => {
    const patch = userChangesPatch('a\nb\nc\nd\ne\n', 'a\nb\nC!\nd\ne\n')!
    expect(patch).toBeDefined()
    const lines = patch.split('\n')
    expect(lines[0]).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/)
    expect(lines).toContain('-c')
    expect(lines).toContain('+C!')
    expect(patch).not.toMatch(/^(---|\+\+\+|Index:|=+$)/m)
  })

  it('「\\ No newline at end of file」行被丢掉', () => {
    const patch = userChangesPatch('a\nb', 'a\nc')!
    expect(patch).toContain('-b')
    expect(patch).toContain('+c')
    expect(patch).not.toContain('No newline')
    expect(patch.split('\n').some((l) => l.startsWith('\\'))).toBe(false)
  })

  it('超过 6000 字符 → 截断，并带上「文档本身是最新的」的说明', () => {
    const before = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
    const after = Array.from({ length: 400 }, (_, i) => `changed line number ${i}`).join('\n')
    const patch = userChangesPatch(before, after)!
    const note = '\n… (more changes; the document above is current)'
    expect(patch.endsWith(note)).toBe(true)
    expect(patch.length).toBe(6000 + note.length)
  })
})

describe('D6 diffToChanges 往返', () => {
  const cases: Array<[string, string, string]> = [
    ['空 → 文本', '', 'hello\nworld'],
    ['文本 → 空', 'hello\nworld', ''],
    ['CJK', '今天天气很好，我们去公园。', '今天天气不错，我们去图书馆吧。'],
    ['emoji', 'a 😀 b 👍🏽 c', 'a 😃 b c 🎉'],
    ['相邻的删 + 增', 'abc def ghi', 'abc XYZ ghi'],
    ['多行', '# T\n\none two\nthree\n', '# T!\n\none 2\nthree\nfour\n']
  ]

  for (const granularity of ['chars', 'words'] as const) {
    it.each(cases)(`${granularity}：%s`, (_label, from, to) => {
      const changes = diffToChanges(from, to, granularity)
      // 位置都在 from 里、按顺序、互不重叠
      let last = 0
      for (const c of changes) {
        expect(c.from).toBeGreaterThanOrEqual(last)
        expect(c.to).toBeGreaterThanOrEqual(c.from)
        last = c.to
      }
      expect(ChangeSet.of(changes, from.length).apply(doc(from)).toString()).toBe(to)
    })
  }

  it('相同 → 空列表', () => {
    expect(diffToChanges('same', 'same')).toEqual([])
    expect(diffToChanges('same', 'same', 'words')).toEqual([])
  })

  it('相邻的删 + 增合成一处改动', () => {
    expect(diffToChanges('abc def ghi', 'abc XYZ ghi', 'words')).toEqual([
      { from: 4, to: 7, insert: 'XYZ' }
    ])
  })
})

describe('D7 mergeExternalChange', () => {
  /** 合并结果落在 ours 上 */
  const merged = (base: string, ours: string, disk: string): string =>
    mergeExternalChange(base, ours, disk).apply(doc(ours)).toString()

  it('用户没改过（ours == base）→ 结果就是磁盘', () => {
    const base = '# T\n\nalpha\n\nbeta\n'
    const disk = '# T\n\nalpha one\n\nbeta two\n\ngamma\n'
    const changes = mergeExternalChange(base, base, disk)
    expect(changes.length).toBe(base.length)
    expect(merged(base, base, disk)).toBe(disk)
  })

  it('两边改的是不同段落 → 两边都留下', () => {
    const base = 'First paragraph here.\n\nSecond paragraph here.\n'
    const ours = 'First paragraph here, edited by the user.\n\nSecond paragraph here.\n'
    const disk = 'First paragraph here.\n\nSecond paragraph rewritten on disk.\n'
    expect(merged(base, ours, disk)).toBe(
      'First paragraph here, edited by the user.\n\nSecond paragraph rewritten on disk.\n'
    )
  })

  it('磁盘与缓冲一样 → 空改动', () => {
    const base = 'one two three'
    const ours = 'one TWO three'
    const changes = mergeExternalChange(base, ours, ours)
    expect(changes.empty).toBe(true)
    expect(changes.length).toBe(ours.length)
  })

  it('两边在同一处插入 → 只留用户的', () => {
    const base = 'alpha beta gamma'
    const ours = 'alpha USER beta gamma'
    const disk = 'alpha DISK beta gamma'
    expect(merged(base, ours, disk)).toBe(ours)
  })

  it('磁盘删掉的一段里有用户刚插入的字 → 那一段是用户的版本（删除不从用户的字中间穿过去）', () => {
    const base = 'keep this. drop alpha beta gamma now. tail stays.'
    const ours = 'keep this. drop alpha TYPED beta gamma now. tail stays.'
    const disk = 'keep this. tail stays.'
    const out = merged(base, ours, disk)
    expect(out).toContain('TYPED')
    expect(out).toBe(ours)
  })

  it('两边做了同一处修改、用户另外还改了一处 → 不做两遍', () => {
    const base = 'one two three four five'
    const ours = 'one TWO three four FIVE'
    const disk = 'one TWO three four five'
    const out = merged(base, ours, disk)
    expect(out).toBe(ours)
    expect(out.match(/TWO/g)).toHaveLength(1)
  })

  it('用户改动与磁盘改动紧挨着（相接）也算撞上 → 用户赢', () => {
    const base = 'aaa bbb ccc'
    // 用户把 bbb 换成 BBB，磁盘把紧挨着的「 」+ ccc 换掉
    const ours = 'aaa BBB ccc'
    const disk = 'aaa bbb-ccc'
    expect(merged(base, ours, disk)).toBe(ours)
  })

  it('外部改动在用户改动之后：映射过用户的改动再落下（位置不错位）', () => {
    const base = 'start. middle. end.'
    const ours = 'start, with a much longer user insertion. middle. end.'
    const disk = 'start. middle. THE END.'
    expect(merged(base, ours, disk)).toBe(
      'start, with a much longer user insertion. middle. THE END.'
    )
  })
})
