/**
 * 单 `$` 行内公式的定界符收紧 —— 跟在 remark-math 之后跑。
 *
 * remark-math（micromark-extension-math）把单 `$` 当代码跨度那样处理：只要后面还能
 * 找到一个 `$` 就成对。这在助手对话里是灾难，因为它吞掉的全是日常正文：
 *
 *   付了 $5，找零 $2            → 公式「5，找零 」
 *   用 $PATH 和 $HOME 两个变量   → 公式「PATH 和 」
 *   sed 里 $1 是第一个捕获组，$2  → 公式「1 是第一个捕获组，」
 *
 * 采用的是 Pandoc 的规则，与笔记本 live preview（atomic-editor/math-blocks.ts）一致：
 * 开定界符后一个字符不能是空白、闭定界符前一个字符不能是空白、闭定界符后一个字符
 * 不能是数字。三条都过才认公式，否则原样退回文本。
 *
 * 为什么是「事后否决」而不是自己写扫描器：`$…$` 必须在 micromark 那一层就被吃成一个
 * 不透明节点，否则 `$a_1$ 和 $b_2$` 里的两个 `_` 会被 Emphasis 配上对，把中间的正文
 * 变成斜体（笔记本那边踩过同一个坑）。所以先让 remark-math 正常分词，再把不合规的
 * 节点换回 text —— 此时 markdown 构造已经解析完毕，退回的文本不会被二次解析。
 *
 * 判定读的是**原文**（`node.position` 切片）而不是节点的 value：micromark 会像代码跨度
 * 一样把两端各一个空格吃掉，`$ x $` 的 value 是 `x`，光看 value 分辨不出它开头有空白。
 *
 * `$$…$$` 不在管辖范围内 —— 双美元没有歧义，一律放行。
 */

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

const DIGIT = /[0-9]/

/** 节点在原文里的完整片段（含定界符）；拿不到位置信息时返回 null */
function rawOf(node: MdNode, src: string): string | null {
  const from = node.position?.start.offset
  const to = node.position?.end.offset
  if (from === undefined || to === undefined) return null
  return src.slice(from, to)
}

/**
 * 否决时退回的文本 —— 用节点 value 重建，而不是直接拿原文切片。
 *
 * 切片的起止是**文档绝对偏移**，跨行时会把续行行首的容器前缀一起圈进来：
 * 块引用里 `> 预算 $5\n> 实际 $6200` 切出来是 `$5\n> 实际 $`，那个 `>` 退回正文后
 * 会在块引用里真的显示出来（列表续行同理，多出的是缩进空格）。node.value 是块级解析
 * 之后的内容，前缀已被剥掉、换行仍保留，正是要还原的东西。
 *
 * 唯一要补的是 micromark 像代码跨度那样吃掉的两端填充：两端都是空白时各吃一个。
 * 判据取自原文切片的**定界符相邻位**（第一行的 raw[1] 与闭合符前一位），这两处不会
 * 被前缀污染。
 */
function restoredText(raw: string, value: string): string {
  const first = raw[1]
  const last = raw[raw.length - 2]
  const padded =
    first !== undefined &&
    last !== undefined &&
    /\s/.test(first) &&
    /\s/.test(last) &&
    value.trim() !== ''
  return padded ? `$${first}${value}${last}$` : `$${value}$`
}

/** Pandoc 三条规则；`$$` 直接放行 */
function isMath(raw: string, src: string, node: MdNode): boolean {
  const fence = /^\$+/.exec(raw)?.[0].length ?? 0
  if (fence !== 1) return true

  const inner = raw.slice(1, -1)
  if (!inner || /^\s/.test(inner) || /\s$/.test(inner)) return false

  // 闭定界符落在行内代码跨度里 —— 「花了 $5 修 `$PATH`」的闭合 `$` 在反引号之内，
  // 前一个字符是反引号（非空白），Pandoc 三条规则全过，正文照吞。行内代码优先级高于
  // math，所以真公式里的反引号只会成对出现；奇数个即说明这一段跨进了代码跨度。
  // （笔记本那边是在扫描期直接跳过 codeSpans，事后否决拿不到那份信息，用奇偶数兜。）
  if ((inner.match(/`/g)?.length ?? 0) % 2 === 1) return false

  // 闭定界符被反斜杠转义 —— `$a\$b$` 会配成半截公式（TeX 源码 `a\`），KaTeX 只能红字降级。
  // 事后否决改不了配对，但可以退回安全的那一侧：末尾反斜杠为奇数即否决。
  let slashes = 0
  for (let i = inner.length - 1; i >= 0 && inner[i] === '\\'; i--) slashes++
  if (slashes % 2 === 1) return false

  const after = src[node.position?.end.offset ?? src.length]
  return !(after && DIGIT.test(after))
}

export function remarkMathDollarGuard() {
  return (tree: MdNode, file: unknown): void => {
    const src = String(file)

    const walk = (node: MdNode): void => {
      const kids = node.children
      if (!kids) return
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i]
        // 块级 `math`（独占若干行的 `$$`）无歧义，不碰
        if (child.type !== 'inlineMath') {
          walk(child)
          continue
        }
        const raw = rawOf(child, src)
        if (raw && !isMath(raw, src, child)) {
          kids[i] = {
            type: 'text',
            value: restoredText(raw, child.value ?? ''),
            position: child.position
          }
        }
      }
    }

    walk(tree)
  }
}
