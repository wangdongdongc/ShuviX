/**
 * 提示词块的占位符渲染 —— `md prompt=<name>` 块经 `prompt(name, extras?)` 取用时走这里。
 *
 * 为什么提示词要从脚本里搬进 md 块（设计见 docs/bot-design.md §3.5.1）：提示词是**文案**。
 * 写在 JS 里它是 `[…].join('\n')` 的字符串拼接 —— 没有高亮、没有换行、改一句话要先读懂
 * 一段程序。搬进 md 块之后脚本只剩流程（`run(agent, prompt('gate'), {schema})`），
 * 而「我想让它换个说法」变成改一段可读的 markdown。
 *
 * 语法刻意只有一条 —— `{{path}}`，没有条件、没有循环、没有过滤器：
 *  - 值为 string/number/boolean → 直接代入；
 *  - 值为数组 → 逐项 `String()` 后按行拼（调用方负责把窗口切到预算内再传进来 ——
 *    `prompt('task', { window: input.window.slice(-vars.taskWindow) })` 是一个表达式，
 *    比在模板里发明一套切片语法便宜得多）；
 *  - 值为对象 → JSON；
 *  - **解析不出 / 为空 → 整行消失**（若该行除占位符外只有空白）。可选上下文因此不留空洞，
 *    与 agent md `{{shuvix:*}}` 的空值收敛是同一条约定；
 *  - 形状不像路径的 `{{…}}` 原样保留（同 agent md 对未知占位符的处置）。
 */

/** `{{a.b.c}}`；路径段为标识符，段间以点分隔 */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*\}\}/g

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

/**
 * 渲染一份提示词模板。纯函数、恒不抛（作用域里的怪值只会渲染成空）。
 *
 * `scope` 通常是 `{ ...input, input, vars, event, ...extras }` —— 顶层平铺是为了
 * `{{message.text}}` 这种最常见的写法不必写成 `{{input.message.text}}`。
 */
export function renderPromptTemplate(template: string, scope: Record<string, unknown>): string {
  const rendered = template.split('\n').flatMap((line) => {
    let sawPlaceholder = false
    let allEmpty = true
    const out = line.replace(PLACEHOLDER_RE, (_match, path: string) => {
      sawPlaceholder = true
      const text = stringify(resolvePath(scope, path))
      if (text !== '') allEmpty = false
      return text
    })
    // 「这一行只是为了放占位符」且占位符全空 → 整行消失（可选上下文不留空洞）
    if (sawPlaceholder && allEmpty && out.trim() === '') return []
    return [out]
  })
  // 代入多行值后常留下 3 行以上空白：收敛成一个空行（同 agent md 的空值收敛）
  return rendered
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
