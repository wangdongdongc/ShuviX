import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Image, ImageOff } from 'lucide-react'
import { remoteImageUrl } from '../../utils/rehypeHoldImages'

/**
 * 按钮在 Chromium 里总按 inline-block 排（写 `inline` 也一样），占位的 span 跟着用 inline-block，两种框才一样高；
 * 竖直对齐就是默认的 baseline —— 框里的字与正文同一条基线（PathChip 的 align-[-2px] 是给无框的图标 + 文字用的，
 * 搬到这里会让框和字整体比正文低 2px）。
 */
const CHIP =
  'inline-block max-w-full rounded px-1 mx-0.5 border border-dashed border-border-secondary text-[0.9em] break-all text-left text-text-secondary'
const CHIP_ICON = 'inline align-[-1.5px] mr-1 flex-shrink-0'

/**
 * 对话流里的一张图 —— rehypeHoldImages 产出的 `<held-image>`。显示时**不取图**（为什么见那个文件头）：
 *  - 有 url（写明 https 的绝对地址）→ 一个按钮：图标 + alt + 主机名，完整地址在 title 里；用户点了才换成
 *    真正的 `<img>`（不带 Referer）。图片包在链接里时，这一下只加载、不跟着跳转，也不再往外冒；
 *  - 没有 url → 只是占位：图标 + alt，title 说明为什么没显示。
 *
 * 「点过」记的是**点的那个地址**，不是一个布尔：同一位置上的实例在流式输出里会拿到新的 url（后到的引用式
 * 定义 `[r]: https://…` 会改掉前面 `![a][r]` 的地址，组件按位置复用），记布尔就等于替用户点了新地址。
 * url 在这里再过一遍 remoteImageUrl：这个组件只认 https，不管 props 从哪来。
 */
export function HeldImage({ alt, url }: { alt?: string; url?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const href = remoteImageUrl(url)
  const label = alt?.trim() || t('message.imageAltFallback')

  if (!href) {
    return (
      <span data-held-image="" title={t('message.imageNotShown')} className={CHIP}>
        <ImageOff size={12} className={CHIP_ICON} />
        {label}
      </span>
    )
  }
  if (loadedUrl === href) {
    return <img src={href} alt={alt ?? ''} referrerPolicy="no-referrer" className="max-w-full" />
  }
  const host = new URL(href).host
  return (
    <button
      type="button"
      data-held-image=""
      title={`${href}\n${t('message.imageClickToLoad', { host })}`}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setLoadedUrl(href)
      }}
      className={`${CHIP} transition-colors hover:bg-bg-tertiary/50 hover:text-text-primary`}
    >
      <Image size={12} className={CHIP_ICON} />
      {label}
      <span className="text-text-tertiary"> · {host}</span>
    </button>
  )
}
