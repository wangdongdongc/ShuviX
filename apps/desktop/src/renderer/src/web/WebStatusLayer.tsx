/**
 * web 客户端的浮层（server mode phase C / D）：
 *
 *  - **连接横幅**：socket 不在时顶部居中一条「正在连接 / 正在重新连接 ShuviX…」（第一次连上之前也显示，
 *    但等 600ms 再出来，免得正常加载时一闪）；连上即消失。
 *  - **桌面专属提示**：点了浏览器里没有对应物的东西（悬浮窗、内置浏览器窗口）时，底部浮出一句说明，
 *    几秒后自己消失 —— 不悄悄当作什么都没发生。
 *  - **服务端路径**（phase D）：「在文件管理器中打开 / 显示」换成一张卡片：那个路径在运行 ShuviX 的电脑上，
 *    可以选中、可以一键复制；用户关掉为止（`webPathNotice`）。
 *  - **目录浏览器**（phase D）：代替原生的「选择文件夹」框（`WebDirectoryPicker`）。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, FolderOpen, Loader2, MonitorSmartphone, X } from 'lucide-react'
import type { WsConnection } from './wsConnection'
import { currentNotice, subscribeNotice } from './webNotices'
import { currentServerPath, dismissServerPath, subscribeServerPath } from './webPathNotice'
import { WebDirectoryPicker } from './WebDirectoryPicker'
import { copyText } from './copyText'

/** 提示停留的时长 */
const NOTICE_MS = 4000
/** 第一次连接时横幅晚出现多久（正常加载不闪） */
const FIRST_CONNECT_GRACE_MS = 600

export function WebStatusLayer({
  connection
}: {
  connection: WsConnection
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const state = useSyncExternalStore(
    (listener) => connection.onState(() => listener()),
    () => connection.state()
  )
  const current = useSyncExternalStore(subscribeNotice, currentNotice)
  const [graceOver, setGraceOver] = useState(false)
  /** 已经到时、该收起的那条提示 */
  const [expiredNotice, setExpiredNotice] = useState<number | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setGraceOver(true), FIRST_CONNECT_GRACE_MS)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (current === null) return
    const timer = setTimeout(() => setExpiredNotice(current.id), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [current])

  const showBanner = state === 'reconnecting' || (state === 'connecting' && graceOver)

  return (
    <>
      {showBanner && (
        <div
          data-web-connection={state}
          role="status"
          className="fixed top-3 left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-2 rounded-full border border-border-secondary bg-bg-secondary px-3.5 py-1.5 text-[12px] text-text-primary shadow-lg"
        >
          <Loader2 size={12} className="animate-spin text-text-tertiary" />
          {state === 'reconnecting' ? t('web.reconnecting') : t('web.connecting')}
        </div>
      )}
      {current !== null && expiredNotice !== current.id && (
        <div
          data-web-notice={current.channel}
          role="status"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[1000] flex max-w-[90vw] items-center gap-2 rounded-lg border border-border-secondary bg-bg-secondary px-3.5 py-2 text-[12px] text-text-primary shadow-lg"
        >
          <MonitorSmartphone size={13} className="shrink-0 text-text-tertiary" />
          {t('web.desktopOnly')}
        </div>
      )}
      <ServerPathCard />
      <WebDirectoryPicker />
    </>
  )
}

/** 复制之后按钮上「已复制」停留的时长 */
const COPIED_MS = 1500

/** 「在文件管理器中打开 / 显示」在浏览器里的样子：显示服务端路径 + 复制 */
function ServerPathCard(): React.JSX.Element | null {
  const { t } = useTranslation()
  const notice = useSyncExternalStore(subscribeServerPath, currentServerPath)
  /** 复制结果（按通知 id 记，换了一条就回到初始） */
  const [copied, setCopied] = useState<{ id: number; ok: boolean } | null>(null)

  useEffect(() => {
    if (copied === null) return
    const timer = setTimeout(() => setCopied(null), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  if (notice === null) return null
  const state = copied?.id === notice.id ? copied : null
  return (
    <div
      data-web-path-notice={notice.channel}
      data-web-path={notice.path}
      role="status"
      className="fixed top-12 left-1/2 -translate-x-1/2 z-[1000] w-[min(560px,92vw)] rounded-lg border border-border-secondary bg-bg-secondary px-3.5 py-2.5 text-[12px] text-text-primary shadow-lg"
    >
      <div className="flex items-center gap-2">
        <FolderOpen size={13} className="shrink-0 text-text-tertiary" />
        <span className="flex-1 min-w-0 text-text-secondary">
          {notice.target === 'folder' ? t('web.pathNoticeFolder') : t('web.pathNoticeFile')}
        </span>
        <button
          type="button"
          data-web-path-close=""
          onClick={() => dismissServerPath(notice.id)}
          className="p-0.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover"
          title={t('common.close')}
        >
          <X size={13} />
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <code
          data-web-path-text=""
          className="flex-1 min-w-0 select-all break-all rounded bg-bg-tertiary/60 px-2 py-1 font-mono text-[11px]"
        >
          {notice.path}
        </code>
        <button
          type="button"
          data-web-path-copy={state ? (state.ok ? 'copied' : 'failed') : ''}
          onClick={() => {
            const id = notice.id
            void copyText(notice.path).then((ok) => setCopied({ id, ok }))
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover"
        >
          {state?.ok ? <Check size={12} /> : <Copy size={12} />}
          {state ? (state.ok ? t('web.copied') : t('web.copyFailed')) : t('web.copyPath')}
        </button>
      </div>
    </div>
  )
}
