/**
 * ```artifact 引用围栏 —— 回复里指名一件会话产物，界面渲染那件产物的内容（对话里留下的是一行名字，
 * 不是几 KB 源码）。
 *
 * 两边读同一个围栏：渲染端（chat-ui CodeBlock）逐块判「这是不是引用、指的是谁」；宿主在一条回复写完时
 * 把整段正文里的引用都找出来，钉住每个名字此刻的版本（桌面 `services/artifacts/pins.ts`）。名字的取法
 * 必须一致，钉下的才查得到 —— 所以都在这里。
 */

/** 围栏语言名（大小写敏感，与 ```svg 那档一致：提示词教的是小写） */
export const ARTIFACT_FENCE_LANG = 'artifact'

/**
 * ```artifact 围栏体 → 要展示的那件 artifact 的名字；不是引用围栏、或围栏体是空的就 null。
 *
 * 只取**第一行**：围栏里只该有一个名字，多出来的行是模型把说明写进了围栏。空体不渲染引用 ——
 * 流式期间围栏刚开、名字还没写出来时也走这条，否则会先闪一张「找不到」卡。
 */
export function artifactRefName(lang: string, code: string): string | null {
  if (lang !== ARTIFACT_FENCE_LANG) return null
  const first = code.trim().split('\n')[0].trim()
  return first || null
}

/** 栅栏开头：最多缩进 3 格，3 个以上反引号或波浪号，后面是 info string（反引号栅栏的 info 里不能有反引号） */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/**
 * 一段 markdown 里引用到的产物名字（按出现顺序、去重；取名规则同 `artifactRefName`）。
 *
 * 按 CommonMark 的围栏规则逐行走，与渲染端（react-markdown）认的是同一批块：语言取 info string 的第一个词
 * （`artifact foo` 也是引用）；收尾是同一种字符、不短于开头的一串，后面只能有空白；别的围栏里的
 * ```artifact（比如一段 ````md 示例）只是那段代码的内容。**只收闭合的**：没写完的围栏不是一个确定的引用
 * （宿主不为它钉版本，渲染端照最新版显示）。引用块、列表里的围栏不在此列 —— 模型的回复里不这么写。
 */
export function artifactFenceNames(markdown: string): string[] {
  const names: string[] = []
  let open: { char: string; length: number; lang: string; body: string[] } | null = null
  for (const line of markdown.split(/\r?\n/)) {
    if (open) {
      const close = new RegExp(`^ {0,3}\\${open.char}{${open.length},}[ \\t]*$`)
      if (close.test(line)) {
        const name = artifactRefName(open.lang, open.body.join('\n'))
        if (name && !names.includes(name)) names.push(name)
        open = null
      } else {
        open.body.push(line)
      }
      continue
    }
    const m = FENCE_OPEN_RE.exec(line)
    if (!m) continue
    const fence = m[1]
    const info = m[2].trim()
    if (fence[0] === '`' && info.includes('`')) continue
    open = { char: fence[0], length: fence.length, lang: info.split(/\s+/)[0] ?? '', body: [] }
  }
  return names
}
