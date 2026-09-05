/**
 * 提示词块的占位符渲染 —— `md prompt=<name>` 块经 `prompt(name, extras?)` 取用时走这里。
 *
 * 为什么提示词要从脚本里搬进 md 块（设计见 docs/bot-design.md §3.5.1）：提示词是**文案**。
 * 写在 JS 里它是 `[…].join('\n')` 的字符串拼接 —— 没有高亮、没有换行、改一句话要先读懂
 * 一段程序。搬进 md 块之后脚本只剩流程（`run(agent, prompt('gate'), {schema})`），
 * 而「我想让它换个说法」变成改一段可读的 markdown。
 *
 * 语法刻意只有两样 —— 没有条件、没有循环、没有过滤器：
 *
 *  - `{{path}}` 取值：string/number/boolean 直接代入；数组逐项 `String()` 后按行拼
 *    （调用方负责把窗口切到预算内再传进来 —— `prompt('task', { window: input.window.slice(-vars.taskWindow) })`
 *    是一个表达式，比在模板里发明一套切片语法便宜得多）；对象取 JSON；
 *    **解析不出 / 为空 → 整行消失**（若该行除占位符外只有空白）。可选上下文因此不留空洞，
 *    与 agent md `{{shuvix:*}}` 的空值收敛是同一条约定；形状不像路径的 `{{…}}` 原样保留
 *    （同 agent md 对未知占位符的处置）。
 *  - `{{>name}}` 引用同一份 workflow 里的另一个 `md prompt=name` 块，在**同一作用域**里
 *    渲染后代入。被引用的块是「可选上下文」：它的占位符**全空 → 整块消失**（标题跟着值一起走），
 *    没有占位符的静态块恒出现。有了它，「有内容才出现的一段」直接住在 md 里 —— 脚本不再
 *    为每个可选小节预拼一个「要么整段要么空串」的字符串。引用不存在的块、引用成环在解析期
 *    就整份拒绝（workflowFile.ts）；这里只是纯函数「恒不抛」的兜底：两者都渲染成空。
 */

/**
 * 一枚记号：`{{a.b.c}}` 占位符（路径段为标识符，段间以点分隔），
 * 或 `{{>name}}` 块引用（名字与 `md prompt=<name>` 同一字符集）。
 */
const TOKEN_RE =
  /\{\{\s*(?:(>)\s*([A-Za-z_][A-Za-z0-9_-]*)|([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*))\s*\}\}/g

/** 一份模板里引用了哪些块（去重、按出现序）—— 解析器据此校验引用与成环 */
export function promptIncludes(template: string): string[] {
  const out: string[] = []
  for (const m of template.matchAll(TOKEN_RE)) {
    if (m[1] && !out.includes(m[2])) out.push(m[2])
  }
  return out
}

function resolvePath(scope: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = scope
  for (const seg of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[seg]
  }
  return cursor
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // 数组逐项 String/JSON —— 与标量分支同样带兜底：宿主塞进 extras 的窗口就是「一个数组，
  // 元素是宿主给的对象」，循环引用/Symbol 之类的怪值只该渲染成空，不该让 prompt() 抛
  if (Array.isArray(value)) {
    return value
      .map((item) => (item === null || item === undefined ? '' : safeText(item)))
      .filter((line) => line !== '')
      .join('\n')
  }
  return safeText(value)
}

/** 单个非空值 → 文本：对象 JSON、其余 String()；不可序列化/不可转字符串的怪值落为空 */
function safeText(value: unknown): string {
  try {
    return (typeof value === 'object' ? JSON.stringify(value) : String(value)) ?? ''
  } catch {
    return ''
  }
}

interface Rendered {
  text: string
  /** 记号（占位符 + 块引用）总数 */
  tokens: number
  /** 其中渲染出了内容的 */
  nonEmpty: number
}

function renderInto(
  template: string,
  scope: Record<string, unknown>,
  blocks: Record<string, string> | undefined,
  stack: readonly string[]
): Rendered {
  let tokens = 0
  let nonEmpty = 0
  const lines = template.split('\n').flatMap((line) => {
    let sawToken = false
    let allEmpty = true
    const out = line.replace(
      TOKEN_RE,
      (_match, include: string | undefined, blockName: string, path: string) => {
        sawToken = true
        tokens += 1
        const text = include
          ? renderInclude(blockName, scope, blocks, stack)
          : stringify(resolvePath(scope, path))
        if (text !== '') {
          allEmpty = false
          nonEmpty += 1
        }
        return text
      }
    )
    // 「这一行只是为了放记号」且记号全空 → 整行消失（可选上下文不留空洞）
    if (sawToken && allEmpty && out.trim() === '') return []
    return [out]
  })
  return { text: lines.join('\n'), tokens, nonEmpty }
}

/** 被引用的块：同作用域渲染；占位符全空 → 整块消失 */
function renderInclude(
  name: string,
  scope: Record<string, unknown>,
  blocks: Record<string, string> | undefined,
  stack: readonly string[]
): string {
  const template = blocks?.[name]
  // 没有这个块 / 引用成环：解析期已整份拒绝（workflowFile），这里只兜「恒不抛」
  if (template === undefined || stack.includes(name)) return ''
  const sub = renderInto(template, scope, blocks, [...stack, name])
  if (sub.tokens > 0 && sub.nonEmpty === 0) return ''
  return sub.text.trim()
}

/**
 * 渲染一份提示词模板。纯函数、恒不抛（作用域里的怪值只会渲染成空）。
 *
 * `scope` 通常是 `{ ...input, input, vars, event, ...extras }` —— 顶层平铺是为了
 * `{{message.text}}` 这种最常见的写法不必写成 `{{input.message.text}}`。
 * `blocks` 是同一份 workflow 的全部 prompt 块（`{{>name}}` 的解析表）；不给则引用渲染成空。
 */
export function renderPromptTemplate(
  template: string,
  scope: Record<string, unknown>,
  blocks?: Record<string, string>
): string {
  // 代入多行值后常留下 3 行以上空白：收敛成一个空行（同 agent md 的空值收敛）
  return renderInto(template, scope, blocks, [])
    .text.replace(/\n{3,}/g, '\n\n')
    .trim()
}
