/**
 * 单 `$` 定界符收紧的判定表。跑的是**生产同款插件链**（markdownComponents.tsx 里的
 * `markdownRemarkPlugins` = remark-gfm → remark-math → guard），断言落在 mdast 上：
 *
 *   - 「是不是公式」看有没有 inlineMath/math 节点；
 *   - 「否决后正文有没有丢字」看所有 text 节点 value 的**拼接**是否还原原文。
 *
 * 拼接不能省：否决产生的 text 不与相邻 text 合并，`付了 $5，找零 $2` 拍平后是三个 text
 * 节点（`付了 `、`$5，找零 $`、`2`），盯单个节点会写出假绿或假红。
 *
 * G 组（末尾 describe）故意用**不装 guard 的裸链**，钉的是上游 remark-math 的行为：
 * guard 的全部判定都建立在「单 `$` 会成对」「position 切片含两端定界符」这两条上，
 * 上游哪天改了，红在那里比红在收紧规则上更好定位。
 */
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, it, expect } from 'vitest'
import { remarkMathDollarGuard } from './remarkMathDollarGuard'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

type Parse = (src: string) => MdNode

const guarded = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkMathDollarGuard)
const bare = unified().use(remarkParse).use(remarkGfm).use(remarkMath)

/** 生产链：remark-math 分词后跑收紧 */
const parseGuarded: Parse = (src) => guarded.runSync(guarded.parse(src), src) as unknown as MdNode
/** 裸链：只有 remark-math，用来观察上游原始行为 */
const parseBare: Parse = (src) => bare.runSync(bare.parse(src), src) as unknown as MdNode

/** 承载文本的叶子节点类型 —— 拍平只留这些 */
const LEAF = new Set(['text', 'inlineCode', 'code', 'inlineMath', 'math'])

/** 把树拍平成 `[type, value][]` */
function flatten(tree: MdNode): [string, string][] {
  const out: [string, string][] = []
  const walk = (node: MdNode): void => {
    if (LEAF.has(node.type)) out.push([node.type, node.value ?? ''])
    node.children?.forEach(walk)
  }
  walk(tree)
  return out
}

const nodes = (src: string, parse: Parse = parseGuarded): [string, string][] => flatten(parse(src))

/** 所有 text 节点 value 的拼接 —— 判断「正文原样还原」只能看这个 */
const plainText = (src: string, parse: Parse = parseGuarded): string =>
  nodes(src, parse)
    .filter(([type]) => type === 'text')
    .map(([, value]) => value)
    .join('')

/** 全树类型序列 —— 用来断言否决后的文本没有被二次解析成 emphasis/strong */
function nodeTypes(src: string, parse: Parse = parseGuarded): string[] {
  const out: string[] = []
  const walk = (node: MdNode): void => {
    out.push(node.type)
    node.children?.forEach(walk)
  }
  walk(parse(src))
  return out
}

/** 树里剩下的公式节点 */
const mathNodes = (src: string, parse: Parse = parseGuarded): [string, string][] =>
  nodes(src, parse).filter(([type]) => type === 'inlineMath' || type === 'math')

function findByType(node: MdNode, type: string): MdNode | undefined {
  if (node.type === type) return node
  for (const child of node.children ?? []) {
    const hit = findByType(child, type)
    if (hit) return hit
  }
  return undefined
}

/** 取第一个指定类型的节点，取不到直接抛 —— 免得后续断言拿 undefined 写出假绿 */
function firstOfType(tree: MdNode, type: string): MdNode {
  const hit = findByType(tree, type)
  if (!hit) throw new Error(`树里没有 ${type} 节点`)
  return hit
}

describe('正常路径 —— 收紧不能过头', () => {
  it('单 $ 包住的公式照常成节点', () => {
    expect(nodes('$x^2$ 是公式')).toEqual([
      ['inlineMath', 'x^2'],
      ['text', ' 是公式']
    ])
  })

  it('闭定界符落在文末（后面没有字符）不被数字规则误杀', () => {
    expect(nodes('$\\alpha$ 与 $\\beta$')).toEqual([
      ['inlineMath', '\\alpha'],
      ['text', ' 与 '],
      ['inlineMath', '\\beta']
    ])
  })

  it('相邻两个公式里的下划线不会配成斜体', () => {
    const src = '$a_1$ 和 $b_2$'
    expect(nodes(src)).toEqual([
      ['inlineMath', 'a_1'],
      ['text', ' 和 '],
      ['inlineMath', 'b_2']
    ])
    // 这正是「先让 remark-math 吃成不透明节点、再事后否决」的理由
    expect(nodeTypes(src)).not.toContain('emphasis')
  })

  it('内容是纯数字也算公式 —— 规则只看定界符不看内容', () => {
    expect(nodes('价格是 $5$ 美元')).toEqual([
      ['text', '价格是 '],
      ['inlineMath', '5'],
      ['text', ' 美元']
    ])
  })

  it('闭定界符后是非数字标点时保留', () => {
    expect(nodes('结果是 $x$。')).toEqual([
      ['text', '结果是 '],
      ['inlineMath', 'x'],
      ['text', '。']
    ])
  })

  it('块级 $$ 公式 guard 前后完全一致', () => {
    const src = '$$\n\\int_0^1 x\\,dx\n$$'
    // 单个 math 节点，value 不含定界符
    expect(nodes(src)).toEqual([['math', '\\int_0^1 x\\,dx']])
    expect(nodes(src)).toEqual(nodes(src, parseBare))
  })
})

describe('误判防线 —— 日常正文里的 $', () => {
  /** 每行都是裸链会误吞成公式的正文（对照 G 组 R01） */
  const FALSE_POSITIVES: [string, string][] = [
    ['金额与找零', '付了 $5，找零 $2'],
    ['环境变量', '用 $PATH 和 $HOME'],
    ['sed 捕获组', 'sed 里 $1 和 $2'],
    ['价格区间（整数）', '成本 $5-$10 之间'],
    ['价格区间（小数）', '价格 $12.50-$13.75'],
    ['开定界符后有空白', '$ x $ 空格'],
    ['闭定界符后是数字', '结果是 $x$5 美元']
  ]

  it.each(FALSE_POSITIVES)('%s —— 不认成公式', (_label, src) => {
    expect(mathNodes(src)).toEqual([])
  })

  // 否决要退回**原文**，两个 `$` 一个都不能少
  it.each(FALSE_POSITIVES)('%s —— 正文原样还原', (_label, src) => {
    expect(plainText(src)).toBe(src)
  })

  it('判定读原文而非节点 value —— $ 后的空白只在原文里看得见', () => {
    const src = '$ x $ 空格'
    // 上游把两端各一个空格吃掉了，光看 value 分辨不出开头有空白
    expect(nodes(src, parseBare)).toContainEqual(['inlineMath', 'x'])
    expect(mathNodes(src)).toEqual([])
    expect(plainText(src)).toBe(src)
  })

  it('一句里既有真公式也有金额，只否决金额那段', () => {
    expect(nodes('$x^2$ 花了 $5 和 $10')).toEqual([
      ['inlineMath', 'x^2'],
      ['text', ' 花了 '],
      ['text', '$5 和 $'],
      ['text', '10']
    ])
  })

  it('金额在前把后面的真公式一起拖成正文 —— 宁漏勿吞', () => {
    const src = '价格 $5 和 $x$'
    // 上游先把 `$5 和 $` 配成一对，尾部的 `x$` 就没有开定界符了；
    // 事后否决改不了配对，只能连尾部真公式一起留成正文。
    expect(mathNodes(src)).toEqual([])
    expect(plainText(src)).toBe(src)
  })

  it('金额段否决后，后面重新配对的真公式仍是公式', () => {
    expect(nodes('价格从 $5 涨到 $10，公式 $x^2$')).toEqual([
      ['text', '价格从 '],
      ['text', '$5 涨到 $'],
      ['text', '10，公式 '],
      ['inlineMath', 'x^2']
    ])
  })

  it('否决退回的文本不会被二次解析', () => {
    const src = '预算 $5 和 **粗体** $8'
    expect(nodeTypes(src)).not.toContain('strong')
    expect(plainText(src)).toBe(src)
  })
})

describe('转义与代码跨度', () => {
  it('反斜杠转义的 $ 不参与配对', () => {
    const src = '\\$5 和 \\$10'
    expect(mathNodes(src)).toEqual([])
    expect(plainText(src)).toBe('$5 和 $10')
  })

  it('行内代码里的 $ 不参与配对', () => {
    expect(nodes('`$5` 和 `$10`')).toEqual([
      ['inlineCode', '$5'],
      ['text', ' 和 '],
      ['inlineCode', '$10']
    ])
  })

  it('围栏代码块里的 $ 不参与配对', () => {
    expect(nodes('```sh\necho $HOME 和 $PATH\n```')).toEqual([['code', 'echo $HOME 和 $PATH']])
  })

  it('闭定界符落在行内代码跨度里 —— 按 inner 里反引号的奇偶数否决', () => {
    const src = '花了 $5 修 `$PATH`'
    expect(mathNodes(src)).toEqual([])
    expect(plainText(src)).toBe(src)
  })

  it('闭定界符被反斜杠转义 —— 按 inner 末尾反斜杠的奇偶数否决', () => {
    const src = '$a\\$b$'
    expect(mathNodes(src)).toEqual([])
    expect(plainText(src)).toBe(src)
  })

  // 上面两条只钉了「该否决」的方向。奇偶判断写反会被「正常路径」那组挡住（$x^2$ 的
  // 反引号数与末尾反斜杠数都是 0，判反就全军覆没），但改成「只要出现就否决」不会 ——
  // 下面两条是那个方向的锚点：成对的反引号、成对的末尾反斜杠都必须放行。
  it('inner 里成对的反引号不触发否决', () => {
    expect(mathNodes('$a `b` c$')).toEqual([['inlineMath', 'a `b` c']])
  })

  it('inner 末尾成对的反斜杠不触发否决', () => {
    expect(mathNodes('$x\\\\$')).toEqual([['inlineMath', 'x\\\\']])
  })
})

describe('$$ 豁免与定界符边界', () => {
  it('$$ 不受收紧管辖 —— 金额写成 $$ 照样成公式', () => {
    expect(nodes('价格 $$5 和 $$10')).toEqual([
      ['text', '价格 '],
      ['inlineMath', '5 和 '],
      ['text', '10']
    ])
  })

  it('单 $ 与 $$ 混排时只有 $$ 那对成公式', () => {
    expect(nodes('$5 和 $$10$$')).toEqual([
      ['text', '$5 和 '],
      ['inlineMath', '10']
    ])
  })

  it('中间的 $$ 不拆开单 $ 的配对', () => {
    expect(nodes('$a$$b$')).toEqual([['inlineMath', 'a$$b']])
  })

  it('单行 $$…$$ 是 inlineMath 而非块级 math', () => {
    // X3（产品待决，不在本次收紧范围）：单行 `$$…$$` 走 inline 模式不居中，
    // 而笔记本 live preview 那边是居中的。此处按现状钉住，改判定时这条会红。
    expect(nodes('$$E = mc^2$$')).toEqual([['inlineMath', 'E = mc^2']])
  })
})

describe('容器递归与位置契约', () => {
  const CONTAINERS: [string, string, string][] = [
    ['标题', '# 标题 $5 和 $10', '标题 $5 和 $10'],
    ['表格单元格', '| 名目 | 价格 |\n| --- | --- |\n| 午餐 | $5 和 $10 |', '名目价格午餐$5 和 $10'],
    ['链接文字', '[链接 $5 和 $10](https://x.com)', '链接 $5 和 $10'],
    ['强调', '**$5 和 $10**', '$5 和 $10']
  ]

  it.each(CONTAINERS)('%s 里同样否决', (_label, src, visible) => {
    expect(mathNodes(src)).toEqual([])
    expect(plainText(src)).toBe(visible)
  })

  // 跨行否决不能把续行行首的容器前缀（块引用 `> ` / 列表缩进）带进正文 ——
  // 还原走的是 node.value 而非 src.slice()，前缀在块级解析时已被剥掉。
  it('块引用里跨行否决，还原文本不带块引用标记', () => {
    expect(plainText('> 价格 $5\n> 和 $x$ 结束')).toBe('价格 $5\n和 $x$ 结束')
  })

  it('列表续行里跨行否决，还原文本不带缩进', () => {
    expect(plainText('- 预算 $5000\n  实际 $6200')).toBe('预算 $5000\n实际 $6200')
  })

  // 还原用 value 之后仍要补回 micromark 吃掉的两端填充，否则 `$ x $` 会退成 `$x$`
  it('两端填充的否决段原样还原', () => {
    const src = '$ x $ 空格'
    expect(mathNodes(src)).toEqual([])
    expect(plainText(src)).toBe(src)
  })
})

describe('流式与降级', () => {
  it('未闭合的行内公式留成原样文本', () => {
    const src = '计算 $x^2'
    expect(mathNodes(src)).toEqual([])
    expect(plainText(src)).toBe(src)
  })

  it('已闭合的成公式，未闭合的留文本', () => {
    expect(nodes('公式 $x^2$ 与 $y')).toEqual([
      ['text', '公式 '],
      ['inlineMath', 'x^2'],
      ['text', ' 与 $y']
    ])
  })

  it('未闭合的块级 $$ 整段成 math 节点 —— $$ 不在管辖内的代价', () => {
    expect(nodes('推导如下：\n\n$$\n\\int_0^1 x')).toEqual([
      ['text', '推导如下：'],
      ['math', '\\int_0^1 x']
    ])
  })
})

describe('直接调用 —— 位置缺失与 file 形态', () => {
  it('inlineMath 没有 position 时保留为公式且不抛错', () => {
    // 合成树（别的插件造出来的节点可能没有位置信息）：拿不到原文就无从判定，
    // fail-open 保留公式，不能因此抛错把整条渲染链打断。
    const tree: MdNode = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'inlineMath', value: 'x' }] }]
    }
    expect(() => remarkMathDollarGuard()(tree, '$ x $')).not.toThrow()
    expect(flatten(tree)).toEqual([['inlineMath', 'x']])
  })

  it('file 传 VFile-like 与传字符串等价', () => {
    const src = '付了 $5，找零 $2'
    const runGuard = (file: unknown): [string, string][] => {
      const tree = structuredClone(parseBare(src))
      remarkMathDollarGuard()(tree, file)
      return flatten(tree)
    }

    const fromVFile = runGuard({ toString: () => src })
    expect(fromVFile).toEqual(runGuard(src))
    expect(fromVFile).toEqual(nodes(src))
  })
})

describe('上游规则回归（不装 guard 的裸管线）', () => {
  it('单 $ 仍会跨正文成对 —— 红则说明上游自己收紧了', () => {
    expect(nodes('付了 $5，找零 $2', parseBare)).toEqual([
      ['text', '付了 '],
      ['inlineMath', '5，找零 '],
      ['text', '2']
    ])
  })

  it('singleDollarTextMath 默认开着', () => {
    expect(nodes('$x^2$', parseBare)).toEqual([['inlineMath', 'x^2']])
  })

  it('inlineMath 的 position 切片含两端定界符', () => {
    // guard 的全部判定都建立在这条上：切片不含定界符的话 fence 长度、
    // 首尾空白、闭定界符后一个字符全部读错。
    const src = '$x^2$ 是公式'
    const math = firstOfType(parseBare(src), 'inlineMath')
    expect(math.position).toBeDefined()
    expect(src.slice(math.position?.start.offset, math.position?.end.offset)).toBe('$x^2$')
  })

  it('两端各吃掉一个空格 —— 所以 value 看不出首尾空白', () => {
    expect(firstOfType(parseBare('$ x $'), 'inlineMath').value).toBe('x')
  })

  it('中间的 $$ 落在 value 里，不拆成两个节点', () => {
    expect(nodes('$a$$b$', parseBare)).toEqual([['inlineMath', 'a$$b']])
  })
})
