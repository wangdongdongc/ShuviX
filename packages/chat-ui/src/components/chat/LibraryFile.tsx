/**
 * 对话里的文件库链接（rehypeLibraryLinks 换出来的两种元素，docs/file-library-design.md §4）：
 *
 *   - `LibraryImage`：库里的图片直接显示（本机文件，不发外部请求），点一下开预览窗口看原图；
 *     找不到（删了、在回收站、不存在）显示“文件已删除”，不画破图。
 *   - `LibraryLinkChip`：其余文件是一个 chip，点了开预览窗口（web 开新标签页）。
 *
 * 地址经 mediaUrl seam 按 `library:<id>` 拼：库与会话无关，会话参数只是协议要求的一个非空值。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, ImageOff } from 'lucide-react'
import { libraryRef } from '@shuvix/chat-protocol/fileLibrary'
import { useMediaUrl } from '../../host/mediaUrl'
import { useChatStore } from '../../stores/chatStore'

/** 交给 mediaUrl seam 的会话参数（库引用不按会话解析，宿主只要求非空） */
const LIBRARY_MEDIA_SESSION = 'library'

const CHIP =
  'inline max-w-full break-words rounded px-1 py-px bg-bg-tertiary/30 text-[0.92em] text-text-secondary'
const CHIP_ICON = 'inline align-[-1.5px] mr-1 flex-shrink-0'

function openItem(itemId: string): void {
  useChatStore.getState().requestFilePreview(libraryRef(itemId))
}

export function LibraryImage({ item, alt }: { item: string; alt?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const url = useMediaUrl(LIBRARY_MEDIA_SESSION, libraryRef(item))
  // 记的是失败的那个地址：地址变了（恢复后重新解析）就再试
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (url && failedUrl === url) {
    return (
      <span data-library-image={item} data-missing="" className={CHIP}>
        <ImageOff size={12} className={CHIP_ICON} />
        {t('message.libraryFileDeleted')}
      </span>
    )
  }
  if (!url) return <span data-library-image={item} className="inline-block min-h-[1em]" />
  return (
    <img
      src={url}
      alt={alt ?? ''}
      data-library-image={item}
      title={alt || undefined}
      onError={() => setFailedUrl(url)}
      onClick={() => openItem(item)}
      className="max-w-full cursor-zoom-in rounded"
    />
  )
}

export function LibraryLinkChip({
  item,
  children
}: {
  item: string
  children?: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      data-library-link={item}
      title={t('message.libraryFileOpenHint')}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        openItem(item)
      }}
      className="inline max-w-full break-words text-left text-accent hover:underline underline-offset-[3px] decoration-accent/45 decoration-1"
    >
      <FileText size={12} className={CHIP_ICON} />
      {children}
    </button>
  )
}
