/**
 * web 客户端的首帧底色。web 客户端的样式要等入口脚本跑起来才动态加载（`main.tsx` 里 `import('../assets/main.css')`），
 * 那之前页面是浏览器的缺省底色 —— 亮色就是一屏白，深色主题下手机上每开一页都先白一下。`web.html` 的内联脚本因此在
 * 样式到之前先给根元素垫上明暗（`color-scheme`）和上次记下的这个主题的底色（`localStorage['themeBg:<主题 id>']`）。
 *
 * 样式到了之后（这里）：撤掉垫的两样 —— 之后画布跟着 body 的主题底色走（根元素没有背景时 body 的背景铺满画布），
 * 换主题也跟着；再记下每个主题此刻 body 的底色，下次打开就是它。
 */

/** 存每个主题底色的 localStorage 键（web.html 的内联脚本读同一个名字） */
export const THEME_BG_KEY_PREFIX = 'themeBg:'

export function settleFirstPaintBackground(
  doc: Document = document,
  storage: Pick<Storage, 'setItem'> | null = safeLocalStorage()
): void {
  const root = doc.documentElement
  root.style.removeProperty('background-color')
  root.style.removeProperty('color-scheme')
  const view = doc.defaultView
  if (!storage || !view) return
  const remember = (): void => {
    const id = root.getAttribute('data-theme')
    if (!id || !doc.body) return
    const bg = view.getComputedStyle(doc.body).backgroundColor
    // 透明（这个主题的样式还没到）记了也没用：下次垫上去等于没垫
    if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return
    try {
      storage.setItem(THEME_BG_KEY_PREFIX + id, bg)
    } catch {
      // 存不进去（配额、隐私模式）：下次照旧先是缺省底色
    }
  }
  remember()
  new view.MutationObserver(remember).observe(root, {
    attributes: true,
    attributeFilter: ['data-theme']
  })
}

/** 拿 localStorage 本身也可能抛（站点数据被禁用） */
function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
