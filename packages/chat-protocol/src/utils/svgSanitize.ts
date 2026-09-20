/**
 * 渲染后 SVG 的净化 —— 注入宿主 DOM 之前的最后一道闸。
 *
 * 为什么需要：图表源码来自不可信输入（智能体输出的 mermaid 代码块），
 * 而渲染结果是经 innerHTML / dangerouslySetInnerHTML 注入到**特权渲染进程**的 —— 那里
 * 有完整的 window.api（文件写入、终端执行）。任何在该源里执行的脚本都等于完全沦陷。
 *
 * mermaid 自己会用 DOMPurify 清洗节点标签（实测 onerror / onload / iframe / style 都会被剥离），
 * 但那是它的内部实现细节，且**不覆盖 `click <节点> href "javascript:..."` 指令** —— 该指令
 * 产出的锚点会带着 javascript: URL 原样进入 DOM（实测笔记本 mermaid 与对话 mermaid 两条
 * 渲染路径都如此）。当前它点不动纯属偶然，不是设计出来的防御。
 * 本函数把这道防御变成显式的、不依赖上游行为也不依赖偶然的控制。
 *
 * 采用白名单：只放行已知安全的协议与标签，其余一律剥离 —— 黑名单挡不住没想到的写法。
 * 解析用 DOMParser（惰性文档：不执行脚本、不发起资源加载），绝不用临时 DOM 节点 +
 * innerHTML —— 游离节点上的 <img src=x onerror> 照样会触发。
 *
 * ## 两档，按「谁写的」分
 *
 * 两个导出共享同一套白名单与同一次遍历，只在三点上不同 —— 因为来源的威胁模型不同：
 *
 * - `sanitizeRenderedSvg`：**渲染器的产物**（mermaid 把受限语法编译出的 SVG）。作者只能
 *   写 mermaid 源码，标记结构由 mermaid 决定，且它自己先过了一遍 DOMPurify。
 * - `sanitizeAuthoredSvg`：**模型手写的整段 SVG**（聊天里的 ```svg 围栏）。作者直接控制
 *   每一个标签和属性，于是三处在 mermaid 那档必须放行的东西在这档必须关掉：
 *
 *   1. `<style>` —— 注进宿主 DOM 的 <style> 是**全局 CSS**，不是图的局部样式。mermaid 的
 *      样式选择器带自己的 id 前缀，手写的不会；一句 `* { display: none }` 就能把整个界面
 *      抹掉。静态图用内联属性/style 属性足够表达，这个标签没有留下的理由。
 *   2. `<foreignObject>` —— SVG 里的 HTML 岛。mermaid 的 htmlLabels 依赖它，手写的图用
 *      `<text>` 就够；留着等于把整个 HTML 攻击面（定位覆盖层做界面仿冒等）请回来。
 *   3. **远程 URL** —— 只放行片段引用（`#id`）与 data: 位图，http/https/mailto 一律剥离。
 *      一张图本该自包含：放行远程地址就等于给一段不可信标记开了一条「一被渲染就外发
 *      请求」的信标通道（CSP 的 img-src 放行 https:，挡不住），而这与本应用「本地优先、
 *      不出网」的前提直接冲突。代价是图里不能引网图 —— 换来图离线可复现。
 */

/** 可作为完整 URL 出现的安全协议 */
const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** 允许的 data: URL —— 只放行位图。刻意排除 svg+xml：它可以携带脚本，且图表不需要 */
const SAFE_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp|bmp);/

/** 值会被浏览器当作 URL 解析的属性 —— 必须过协议白名单 */
const URL_ATTRIBUTES = new Set([
  'href',
  'xlink:href',
  'src',
  'action',
  'formaction',
  'data',
  'ping',
  'poster',
  'background'
])

/**
 * 两档共同整删的元素。<style> 与 <foreignObject> 不在此列 —— mermaid 的主题样式与
 * htmlLabels 分别依赖它们（标签里的 <style> 在 mermaid 自己的清洗阶段已被剥离）。
 * 手写档另有 AUTHORED_FORBIDDEN_TAGS 把这两个补上。
 */
const FORBIDDEN_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'set',
  'animate',
  'animatetransform',
  'handler'
])

/**
 * `sanitizeAuthoredSvg` 额外整删的标签 —— 见头注释第 1、2 条。
 * 只在手写档生效：mermaid 的主题样式与 htmlLabels 分别依赖这两个标签。
 */
const AUTHORED_FORBIDDEN_TAGS = new Set(['style', 'foreignobject'])

/**
 * 两档的名单本身 —— 供自描述与不变式测试读取。
 *
 * 为什么把内部集合导出：「手写档严格强于 mermaid 档」这个不变式，若只靠对一批样本输入
 * 断言输出，会随白名单演进腐烂成空转门（语料没覆盖到的地方它照样绿）。对**名单本身**
 * 断言是唯一不可能空转的形式：往 FORBIDDEN_TAGS 加标签自动两档生效（差集不变），
 * 往 AUTHORED_FORBIDDEN_TAGS 加一条则必须同时更新那条用例 —— 强制写下理由。
 */
export const SVG_SANITIZE_TIERS = {
  forbiddenTags: FORBIDDEN_TAGS as ReadonlySet<string>,
  authoredExtraTags: AUTHORED_FORBIDDEN_TAGS as ReadonlySet<string>,
  urlAttributes: URL_ATTRIBUTES as ReadonlySet<string>
} as const

/**
 * URL 是否安全。
 * 先剔除控制字符与空白 —— `java\tscript:` / `java\nscript:` 这类写法浏览器解析时会规整成
 * javascript:，若按原样比对就会漏掉。
 */
export function isSafeSvgUrl(value: string, options?: { localOnly?: boolean }): boolean {
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u0020\u007f-\u009f]/g, '').toLowerCase()
  if (v === '') return true
  if (v.startsWith('#')) return true // 片段引用（mermaid 的 marker / use 大量使用）
  if (SAFE_DATA_URL.test(v)) return true
  // 手写档：到这里就只剩「会发起请求的地址」了 —— 相对 URL 也算（渲染进程的 base 是
  // 应用自身，一个相对路径同样是一次真实的本地资源请求）。见头注释第 3 条。
  if (options?.localOnly) return false
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(v)
  if (!scheme) return true // 无协议 = 相对 URL
  return SAFE_URL_PROTOCOLS.has(`${scheme[1]}:`)
}

/**
 * 手写档：属性值里出现的**每一个** `url(...)` 都必须是片段引用（`url(#grad)`）。
 *
 * 为什么不能只看属性名：URL_ATTRIBUTES 拦的是 href/src 这类「名字就是地址」的属性，
 * 而 `style="background-image:url(https://…)"` 与 `fill="url(https://…)"` 走的是 CSS 取值，
 * 名字上看不出来。`url()` 基本就是一条 CSS 声明里唯一还能发起请求的东西（@import 只在
 * 样式表里成立，而手写档的 <style> 整个被删；expression() 一类早已作废），所以约束它
 * 一条就够 —— 但不能一概禁掉：渐变与遮罩靠 `url(#id)`，那是图的正常写法。
 *
 * 判定按**正向要求**写（每个 url( 后必须紧跟 #），不是列举坏写法：不闭合的 `url(https:`
 * 这类残缺形式因此也落在拒绝一侧。对所有属性一视同仁地查，不枚举「哪些属性算 CSS」——
 * 那份名单一定会漂移，而属性值里出现字面量 `url(` 却不是取色引用的情形并不存在。
 */
export function urlFunctionsAreFragmentOnly(value: string): boolean {
  // CSS 的函数名是 ident-token，**允许转义**：`\75 rl(` / `\000075rl(` / `u\72 l(` 经
  // 「consume an escaped code point」后都还是 `url(`，字面量查找一个都看不见。已在真实
  // Chromium 里实测：这三种写法都绕过了下面的查找，并且真的发出了网络请求。
  // 修法不是去补这三种写法 —— 转义形式无穷，那是黑名单。静态图**没有任何理由**需要 CSS
  // 转义，所以反过来要求：属性值里出现反斜杠即判危，整条剥掉。这一刀砍掉的是整个转义类，
  // 而不是已知的几个样本。
  if (value.includes('\\')) return false
  const v = value.toLowerCase()
  let i = v.indexOf('url(')
  while (i !== -1) {
    let j = i + 4
    // 跳过空白与可选引号后，必须是 #
    while (j < v.length && v.charCodeAt(j) <= 0x20) j++
    if (v[j] === '"' || v[j] === "'") j++
    while (j < v.length && v.charCodeAt(j) <= 0x20) j++
    if (v[j] !== '#') return false
    i = v.indexOf('url(', i + 4)
  }
  return true
}

/**
 * 净化渲染后的 SVG 字符串。
 *
 * 用 `text/html` 而非 `image/svg+xml` 解析：mermaid 在 <foreignObject> 里输出的是 HTML 片段
 * （`<br>` 这类不闭合标签在 XML 下直接 parsererror —— 实测会把正常图表整个判死）。HTML 解析器
 * 宽容且同样惰性：DOMParser 产出的文档没有浏览上下文，不执行脚本、不发起资源加载。
 * 输出也随之用 HTML 序列化，正好匹配调用方的 innerHTML / dangerouslySetInnerHTML 注入方式。
 *
 * 找不到 <svg> 根返回空串（**失败关闭**）—— 这是安全控制，宁可不出图也不放行未检查的标记。
 * 调用方应把「输入非空但输出为空」当作渲染错误，让问题可见而不是静默吞掉。
 */
export function sanitizeRenderedSvg(svg: string): string {
  return sanitizeSvg(svg, false)
}

/**
 * 净化**模型手写**的 SVG —— 聊天里 ```svg 围栏的唯一入口。
 *
 * 与 sanitizeRenderedSvg 共用同一套白名单、同一次遍历与同样的失败关闭语义，
 * 额外关掉 <style> / <foreignObject> 与一切会发起请求的地址 —— 理由见头注释「两档」一节。
 * 这一档**严格强于**另一档：凡 mermaid 那边放行的危险写法，这边必然也放不过去。
 */
export function sanitizeAuthoredSvg(svg: string): string {
  return sanitizeSvg(svg, true)
}

/**
 * 输入长度上限 —— 超限直接判死。
 *
 * 净化是**同步**的，而手写档的调用点在 React 渲染体里：一段病态输入（几万层嵌套）
 * 能把渲染进程卡死若干秒，抛出的 RangeError 还会从渲染里冒出去，而且失败结果不进缓存、
 * 于是每次重渲染再炸一次。一张静态图远用不到这个量级；超限是「这不是一张图」的信号。
 */
const MAX_SVG_LENGTH = 256 * 1024

/** 两档共用的实现；`authored` = 来源是模型手写而非渲染器产物 */
function sanitizeSvg(svg: string, authored: boolean): string {
  if (!svg) return ''
  if (svg.length > MAX_SVG_LENGTH) return ''
  if (typeof DOMParser === 'undefined') return '' // 非浏览器环境不应调用；同样失败关闭
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(svg, 'text/html')
  } catch {
    return ''
  }
  const root = doc.body?.querySelector('svg')
  if (!root) return ''

  const doomed: Element[] = []
  const visit = (el: Element): void => {
    const tag = el.nodeName.toLowerCase()
    if (FORBIDDEN_TAGS.has(tag) || (authored && AUTHORED_FORBIDDEN_TAGS.has(tag))) {
      doomed.push(el)
      return // 整棵子树都要删，不必再往下走
    }
    // 逆序遍历：removeAttributeNode 会实时改变 attributes 集合
    for (let i = el.attributes.length - 1; i >= 0; i--) {
      const attr = el.attributes[i]
      const name = attr.name.toLowerCase()
      // 事件处理器：任何 on* 一律剥离（含 SVG 自有的 onbegin/onrepeat 等）
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name)
        continue
      }
      // 手写档：任何属性值里的 url(...) 必须是片段引用（CSS 取值不看属性名，见该函数注释）
      if (authored && !urlFunctionsAreFragmentOnly(attr.value)) {
        el.removeAttribute(attr.name)
        continue
      }
      if (URL_ATTRIBUTES.has(name) && !isSafeSvgUrl(attr.value, { localOnly: authored })) {
        el.removeAttribute(attr.name)
      }
    }
    for (let i = 0; i < el.children.length; i++) visit(el.children[i])
  }
  // 兜底罩住**解析之后的全部工序**，不只是 visit：visit、scopeAuthoredIds 的 walk/rename、
  // 以及 outerHTML 序列化都是递归的，病态嵌套在其中任何一处栈溢出都一样致命 —— 手写档的
  // 调用点在 React 渲染体里，异常会从渲染里冒出去，把整条消息列表带走。上限已挡掉绝大多数
  // （实测真实 Chromium 在上限内的任何深度都不抛，只有 jsdom 的递归序列化器会），但闸门的
  // 宽度该由本函数自称的失败关闭语义决定，而不是由某个引擎今天恰好不抛来决定。
  try {
    visit(root)
    for (const el of doomed) el.remove()

    // 剥空即判死（手写档）—— 一段整个由被禁元素构成的输入，净化后剩一个空 <svg>：
    // 非空字符串会让调用方以为成功，于是用户看到一张**空白图卡**，而不是错误卡加源码；
    // 而「模型整段写的都是被禁的东西」恰恰是最该让人看见源码的情形。
    // mermaid 档不做这个判断：它的产物本就可能是一张合法的空图。
    if (authored && root.children.length === 0) return ''

    return authored ? scopeAuthoredIds(root) : root.outerHTML
  } catch {
    return ''
  }
}

/**
 * 给手写档的 id 加上按内容派生的前缀，并同步改写对它们的引用。
 *
 * 为什么必须做：净化产物是直接注入**文档**的，而 `id` 是全局的。一条回复里两张图都写
 * `<linearGradient id="grad">` 时，第二张的 `url(#grad)` 会解析到文档中先出现的那一个 ——
 * 图画错了但不报错，是最难查的一类。mermaid 档天然免疫（它用自己的 render id 给 id 加前缀），
 * 手写档没有任何东西替它做这件事。
 *
 * 前缀取自**输入内容**而不是一个自增计数器：同一张图重复渲染恒得同一份产物（缓存才成立），
 * 而两张**完全相同**的图共享 id 是正确的 —— 它们的渐变本来就是同一个渐变。
 *
 * 只改写本文档里真正定义过的 id，所以指向别处的引用（不该存在，但若有）不会被悄悄改名。
 */
function scopeAuthoredIds(root: Element): string {
  const ids = new Set<string>()
  const walk = (el: Element): void => {
    const id = el.getAttribute('id')
    if (id) ids.add(id)
    for (let i = 0; i < el.children.length; i++) walk(el.children[i])
  }
  walk(root)
  if (ids.size === 0) return root.outerHTML

  // FNV-1a over the markup —— chat-protocol 是零依赖叶子包，不引哈希库
  let h = 0x811c9dc5
  const src = root.outerHTML
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const prefix = `s${h.toString(36)}`

  const rename = (el: Element): void => {
    const id = el.getAttribute('id')
    if (id && ids.has(id)) el.setAttribute('id', `${prefix}-${id}`)
    for (let i = el.attributes.length - 1; i >= 0; i--) {
      const attr = el.attributes[i]
      if (attr.name.toLowerCase() === 'id') continue
      const next = attr.value.replace(
        /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)|^#([^\s]+)$/g,
        (match, quote: string, fnId: string, bareId: string) => {
          const target = fnId ?? bareId
          if (!ids.has(target)) return match
          return fnId !== undefined
            ? `url(${quote}#${prefix}-${fnId}${quote})`
            : `#${prefix}-${bareId}`
        }
      )
      if (next !== attr.value) el.setAttribute(attr.name, next)
    }
    for (let i = 0; i < el.children.length; i++) rename(el.children[i])
  }
  rename(root)
  return root.outerHTML
}
