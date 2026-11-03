import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { shownImageRef, type ShownImageItem } from '@shuvix/chat-protocol/shownImages'
import type { ShownImage } from '@shuvix/chat-protocol/types/chatMessage'
import { useMediaUrl, useResolveMediaUrl } from '../../host/mediaUrl'
import { useChatDensity } from '../../host/chatHostContext'
import { useChatStore } from '../../stores/chatStore'

/**
 * agent 摆给用户看的图（`show_image` 调用，docs/show-image-design.md §5）—— 画在助手卡片里它被调用的位置，默认就显示
 * （不像工具卡片里「模型收到的那张图」要展开才挂载）：这些图就是交给用户的东西。
 *
 * 和 ToolImageThumb 同两条约束：
 *  - **不碰 base64**：URL 经注入的 mediaUrl seam 取（桌面 `shuvix-preview://`、web 客户端会话那条路由），字节不经 IPC 与
 *    React state；引用是 `shown:<快照文件名>`，宿主到会话自己的快照目录里找。
 *  - **内存**：卡片显示的是展示副本（大图宿主已缩到长边 2048），`loading="lazy"`，列表本身也是虚拟化的。
 *
 * 点图走 requestFilePreview（有原图就开原图）：桌面开独立预览窗口，web 客户端开新标签页。
 *
 * 宿主没注入 mediaUrl seam（Chrome 侧栏）就取不到图：调用方先看 `useResolveMediaUrl()`，没有就照普通工具行显示
 * （StepGroupView）；提议卡片里的图则干脆不画（ShownImageView 交回 null）。
 */
export function ShownImagesBlock({ items }: { items: ShownImageItem[] }): React.JSX.Element | null {
  const touch = useChatDensity() === 'touch'
  if (items.length === 0) return null
  if (items.length === 1) {
    return (
      <div data-shown-images className="my-2">
        <ShownImageView image={items[0].image} caption={items[0].caption} variant="single" />
      </div>
    )
  }
  return (
    <div data-shown-images className="my-2 @container">
      <div className={`grid gap-2 grid-cols-2 ${touch ? '' : '@[36rem]:grid-cols-3'}`}>
        {/* 按下标作 key：快照按内容去重，同一张图摆两次文件名相同 */}
        {items.map((item, index) => (
          <ShownImageView key={index} image={item.image} caption={item.caption} variant="tile" />
        ))}
      </div>
    </div>
  )
}

/** 图的显示形态：单张（列宽内、高度封顶）/ 网格里的一格 / 提议卡片右边的缩略图位（铺满那个位置） */
type ShownImageVariant = 'single' | 'tile' | 'thumb'

/**
 * 提议卡片缩略图位的尺寸（SuggestionCards 给每行留的空位用同一个，才对得齐）：定宽，这是最矮的高度，文字多时随这一行变高。
 * 触屏密度（手机）栏窄，略小一点
 */
export function shownThumbBoxClass(touch: boolean): string {
  return touch ? 'min-h-14 w-20' : 'min-h-16 w-24'
}

const IMG_CLASS: Record<ShownImageVariant, string> = {
  single: 'max-h-[min(60vh,480px)] max-w-full w-auto rounded-md border border-border-secondary/60',
  tile: 'h-40 w-full rounded-md bg-bg-tertiary',
  thumb: 'h-full w-full rounded-md border border-border-secondary/60 bg-bg-tertiary'
}

/** 一张图：取地址、画出来、点开看原图；文件没了说一句 */
export function ShownImageView({
  image,
  caption,
  variant
}: {
  image: ShownImage
  caption?: string
  variant: ShownImageVariant
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const sessionId = useChatStore((s) => s.activeSessionId)
  const [failed, setFailed] = useState(false)
  const hasResolver = useResolveMediaUrl() !== null
  const url = useMediaUrl(sessionId ?? '', shownImageRef(image.file), image.mimeType)
  const name = image.source.split(/[\\/]/).pop() || t('shownImage.alt')
  if (!hasResolver) return null

  const thumb = variant === 'thumb'
  const body = failed ? (
    <div
      data-shown-image-missing
      className={`rounded-md border border-dashed border-border-secondary text-text-tertiary ${
        thumb
          ? 'flex h-full w-full items-center justify-center p-1 text-center text-[10px] leading-tight'
          : 'px-3 py-2 text-[11px]'
      }`}
    >
      {t('shownImage.missing')}
    </div>
  ) : !sessionId || !url ? null : (
    <button
      type="button"
      title={`${t('shownImage.openHint')}\n${image.source}`}
      className={`block cursor-zoom-in ${
        variant === 'single' ? 'max-w-full' : thumb ? 'h-full w-full' : 'w-full'
      }`}
      onClick={(e) => {
        // 提议卡片里：点图是看图，不是采纳
        e.stopPropagation()
        useChatStore.getState().requestFilePreview(shownImageRef(image.original ?? image.file))
      }}
    >
      <img
        src={url}
        alt={caption ?? name}
        loading="lazy"
        decoding="async"
        // 尺寸已知时先按比例占位，图解码完成不跳版（网格里的一格、缩略图位都是固定框，不需要）
        style={
          variant === 'single' && image.width && image.height
            ? { aspectRatio: `${image.width} / ${image.height}` }
            : undefined
        }
        className={`object-contain ${IMG_CLASS[variant]}`}
        onError={() => setFailed(true)}
      />
    </button>
  )

  return (
    <figure data-shown-image={image.file} className={thumb ? 'h-full w-full' : 'min-w-0'}>
      {body}
      {caption && (
        <figcaption className="mt-1 text-xs text-text-secondary break-words">{caption}</figcaption>
      )}
    </figure>
  )
}
