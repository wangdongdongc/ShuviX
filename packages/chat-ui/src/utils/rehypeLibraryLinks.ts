/**
 * 文件库链接（`shuvix://file/<id>/<文件名>`，docs/file-library-design.md §4）在对话里的样子：
 *
 *   - `![alt](shuvix://file/…)` → `<library-image item alt>`：库里的文件在本机，显示它不发任何外部请求，所以
 *     **直接显示**，不走 rehypeHoldImages 的「点一下才加载」；
 *   - `[文字](shuvix://file/…)` → `<library-link item>`：文件 chip，点了开预览窗口（web 开新标签页）。
 *
 * 为什么换元素而不留 href / src：react-markdown 的 urlTransform 排在所有 rehype 插件之后，只认 http(s) 等
 * 几种协议，会把 `shuvix://` 地址抹掉（同 rehypeSessionLinks）。新元素只带 id，地址由组件按 id 经 mediaUrl seam 拼。
 *
 * 排法：在闸（rehypeSanitizeRawHtml）之后 —— 闸只为形状严格匹配的库链接放过 `a[href]` 与 `img[src]`，手写的
 * `<library-image>` 早在闸那一步就被拆掉了；在 rehypeHoldImages 之前 —— 否则 img 先被它扣成占位。
 */
import type { Element, ElementContent, Root } from 'hast'
import { parseLibraryLink } from '@shuvix/chat-protocol/fileLibrary'

export const LIBRARY_IMAGE_TAG = 'library-image'
export const LIBRARY_LINK_TAG = 'library-link'

function libraryImageOf(img: Element, itemId: string): Element {
  const alt = img.properties?.alt
  return {
    type: 'element',
    tagName: LIBRARY_IMAGE_TAG,
    properties: { item: itemId, ...(typeof alt === 'string' && alt !== '' ? { alt } : {}) },
    children: []
  }
}

function libraryLinkOf(a: Element, itemId: string): Element {
  return {
    type: 'element',
    tagName: LIBRARY_LINK_TAG,
    properties: { item: itemId },
    children: a.children as ElementContent[]
  }
}

function visit(node: Root | Element): void {
  node.children.forEach((child, i) => {
    if (child.type !== 'element') return
    if (child.tagName === 'img') {
      const src = child.properties?.src
      const link = typeof src === 'string' ? parseLibraryLink(src) : null
      if (link) node.children[i] = libraryImageOf(child, link.itemId)
      return
    }
    if (child.tagName === 'a') {
      const href = child.properties?.href
      const link = typeof href === 'string' ? parseLibraryLink(href) : null
      if (link) {
        const replaced = libraryLinkOf(child, link.itemId)
        node.children[i] = replaced
        visit(replaced)
        return
      }
    }
    visit(child)
  })
}

/** rehype 插件形态 —— 排在闸之后、rehypeHoldImages 之前（理由见文件头） */
export function rehypeLibraryLinks() {
  return (tree: Root): void => {
    visit(tree)
  }
}
