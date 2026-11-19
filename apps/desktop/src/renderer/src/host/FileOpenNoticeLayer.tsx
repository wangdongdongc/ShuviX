import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { FileX } from 'lucide-react'
import {
  currentFileOpenNotice,
  dismissFileOpenNotice,
  fileOpenReasonText,
  subscribeFileOpenNotice
} from './fileOpenNotice'

/** 提示停留的时长 */
export const FILE_OPEN_NOTICE_MS = 3500

/**
 * 「这个文件打不开」的轻提示：窗口底部居中一枚小药丸（文件名 · 原因），不抢焦点、不挡点击，
 * 几秒后自己收起（见 fileOpenNotice.ts）。挂在 body 上，免得被某个带 transform 的祖先困住。
 */
export function FileOpenNoticeLayer(): React.JSX.Element | null {
  const { t } = useTranslation()
  const notice = useSyncExternalStore(subscribeFileOpenNotice, currentFileOpenNotice)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => dismissFileOpenNotice(notice.id), FILE_OPEN_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  if (!notice) return null
  return createPortal(
    <div
      key={notice.id}
      data-file-open-notice={notice.refusal.reason}
      role="status"
      className="pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 z-[1000] flex max-w-[min(520px,90vw)] items-center gap-2 rounded-lg border border-border-secondary bg-bg-secondary px-3.5 py-2 text-[12px] text-text-primary shadow-lg"
    >
      <FileX size={13} className="shrink-0 text-text-tertiary" />
      <span className="min-w-0 truncate font-medium" title={notice.name}>
        {notice.name}
      </span>
      <span className="shrink-0 text-text-tertiary">·</span>
      <span className="min-w-0 text-text-secondary">{fileOpenReasonText(t, notice.refusal)}</span>
    </div>,
    document.body
  )
}
