/**
 * 渲染后 SVG 的净化 —— 注入宿主 DOM 之前的最后一道闸。
 *
 * 为什么需要：图表源码来自不可信输入（智能体输出的 mermaid 代码块、磁盘上的图表契约文件），
 * 而渲染结果是经 innerHTML / dangerouslySetInnerHTML 注入到**特权渲染进程**的 —— 那里
 * 有完整的 window.api（文件写入、终端执行）。任何在该源里执行的脚本都等于完全沦陷。
 *
 * mermaid 自己会用 DOMPurify 清洗节点标签（实测 onerror / onload / iframe / style 都会被剥离），
 * 但那是它的内部实现细节，且**不覆盖 `click <节点> href "javascript:..."` 指令** —— 该指令
 * 产出的锚点会带着 javascript: URL 原样进入 DOM（实测两条渲染路径都如此）。当前它点不动
 * 纯属偶然（ChartView 的平移手势用 setPointerCapture 吞掉了点击），不是设计出来的防御。
 * 本函数把这道防御变成显式的、不依赖上游行为也不依赖偶然的控制。
 *
 * 采用白名单：只放行已知安全的协议与标签，其余一律剥离 —— 黑名单挡不住没想到的写法。
 * 解析用 DOMParser（惰性文档：不执行脚本、不发起资源加载），绝不用临时 DOM 节点 +
 * innerHTML —— 游离节点上的 <img src=x onerror> 照样会触发。
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
 * 整个元素删除。<style> 不在此列 —— mermaid 的主题样式靠它，而标签里的 <style>
 * 在 mermaid 自己的清洗阶段就已被剥离；<foreignObject> 同样保留，HTML 标签依赖它。
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
 * URL 是否安全。
 * 先剔除控制字符与空白 —— `java\tscript:` / `java\nscript:` 这类写法浏览器解析时会规整成
 * javascript:，若按原样比对就会漏掉。
 */
export function isSafeSvgUrl(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u0020\u007f-\u009f]/g, '').toLowerCase()
  if (v === '') return true
  if (v.startsWith('#')) return true // 片段引用（mermaid 的 marker / use 大量使用）
  if (SAFE_DATA_URL.test(v)) return true
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(v)
  if (!scheme) return true // 无协议 = 相对 URL
  return SAFE_URL_PROTOCOLS.has(`${scheme[1]}:`)
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
  if (!svg) return ''
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
    if (FORBIDDEN_TAGS.has(el.nodeName.toLowerCase())) {
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
      if (URL_ATTRIBUTES.has(name) && !isSafeSvgUrl(attr.value)) {
        el.removeAttribute(attr.name)
      }
    }
    for (let i = 0; i < el.children.length; i++) visit(el.children[i])
  }
  visit(root)
  for (const el of doomed) el.remove()

  return root.outerHTML
}
