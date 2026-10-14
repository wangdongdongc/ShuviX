/**
 * web 客户端的目录浏览器（server mode phase D）—— 代替原生的「选择文件夹」框（项目文件夹、外部技能目录）。
 * 列的是**运行 ShuviX 的那台电脑**上的目录（`window.api.fs.listDirectories`），从它的主目录开始：点一行进入，
 * 「上一层」「主目录」、直接输入路径回车跳过去、显示隐藏目录的开关；「选择这个文件夹」把当前目录交回调用方，
 * 取消 / Esc / 点遮罩 → null。由 `webDirectoryPick` 的仓库驱动（同一时刻只有一个）。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Folder, Home, Loader2 } from 'lucide-react'
import type { DirectoryListing } from '../../../shared/serverFs'
import {
  currentDirectoryPick,
  settleDirectoryPick,
  subscribeDirectoryPick,
  type DirectoryPickRequest
} from './webDirectoryPick'

export function WebDirectoryPicker(): React.JSX.Element | null {
  const request = useSyncExternalStore(subscribeDirectoryPick, currentDirectoryPick)
  if (request === null) return null
  return <PickerDialog key={request.id} request={request} />
}

function PickerDialog({ request }: { request: DirectoryPickRequest }): React.JSX.Element {
  const { t } = useTranslation()
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [showHidden, setShowHidden] = useState(false)
  const [input, setInput] = useState('')
  /** 最近一次请求自己失败了（断线 …）：列表那里说一声，而不是一片空白 */
  const [fetchFailed, setFetchFailed] = useState(false)
  /** 最近一次请求的序号：慢的旧回包不盖掉新的 */
  const seqRef = useRef(0)

  const fetchListing = useCallback((path: string | undefined, hidden: boolean): void => {
    const seq = ++seqRef.current
    void window.api.fs
      .listDirectories({ ...(path ? { path } : {}), showHidden: hidden })
      .then((next) => {
        if (seq !== seqRef.current) return
        setListing(next)
        setInput(next.path)
        setFetchFailed(false)
        setLoading(false)
      })
      .catch(() => {
        if (seq !== seqRef.current) return
        setFetchFailed(true)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    fetchListing(request.startPath, false)
  }, [fetchListing, request.startPath])

  const navigate = (path: string | undefined, hidden = showHidden): void => {
    setLoading(true)
    fetchListing(path, hidden)
  }

  const cancel = useCallback((): void => settleDirectoryPick(request.id, null), [request.id])
  const choose = (): void => {
    if (listing && !listing.error && !fetchFailed) settleDirectoryPick(request.id, listing.path)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel])

  const btn =
    'inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-40 disabled:pointer-events-none'

  return (
    <div
      className="fixed inset-0 z-[1001] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel()
      }}
    >
      <div
        data-web-directory-picker=""
        role="dialog"
        aria-modal="true"
        aria-label={t('web.pickFolderTitle')}
        className="flex w-[min(560px,92vw)] max-h-[80vh] flex-col rounded-xl border border-border-secondary bg-bg-primary text-text-primary shadow-2xl"
      >
        <div className="px-4 pt-4 pb-2 text-[13px] font-medium">{t('web.pickFolderTitle')}</div>
        <form
          className="flex items-center gap-1.5 px-4 pb-2"
          onSubmit={(e) => {
            e.preventDefault()
            navigate(input.trim() || undefined)
          }}
        >
          <button
            type="button"
            data-web-dir-up=""
            className={btn}
            disabled={!listing?.parent}
            onClick={() => listing?.parent && navigate(listing.parent)}
            title={t('web.pickFolderUp')}
          >
            <ArrowUp size={12} />
          </button>
          <button
            type="button"
            data-web-dir-home=""
            className={btn}
            onClick={() => navigate(undefined)}
            title={t('web.pickFolderHome')}
          >
            <Home size={12} />
          </button>
          <input
            data-web-dir-path=""
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            className="flex-1 min-w-0 h-7 px-2 text-[12px] font-mono rounded-md border border-border-secondary bg-bg-secondary focus:outline-none focus:border-accent"
          />
          <button type="submit" data-web-dir-go="" className={btn}>
            {t('web.pickFolderGo')}
          </button>
        </form>
        <div className="flex-1 min-h-[200px] overflow-y-auto border-y border-border-secondary/60">
          {fetchFailed && !loading ? (
            <div data-web-dir-error="request" className="px-4 py-6 text-[12px] text-error">
              {t('web.pickFolderFailed')}
            </div>
          ) : loading && !listing ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-text-tertiary">
              <Loader2 size={13} className="animate-spin" />
              {t('web.pickFolderLoading')}
            </div>
          ) : listing?.error ? (
            <div data-web-dir-error={listing.error} className="px-4 py-6 text-[12px] text-error">
              {t('web.pickFolderError', { code: listing.error })}
            </div>
          ) : listing && listing.entries.length === 0 ? (
            <div className="px-4 py-6 text-[12px] text-text-tertiary">
              {t('web.pickFolderEmpty')}
            </div>
          ) : (
            <ul className={loading ? 'opacity-60' : undefined}>
              {listing?.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    data-web-dir-entry={entry.name}
                    onClick={() => navigate(entry.path)}
                    className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-[12px] hover:bg-bg-hover"
                  >
                    <Folder size={13} className="shrink-0 text-text-tertiary" />
                    <span className="truncate">{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {listing?.truncated && (
            <div className="px-4 py-2 text-[11px] text-text-tertiary">
              {t('web.pickFolderTruncated', { count: listing.entries.length })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 px-4 py-3">
          <label className="flex items-center gap-1.5 text-[11px] text-text-secondary select-none">
            <input
              type="checkbox"
              data-web-dir-hidden=""
              checked={showHidden}
              onChange={(e) => {
                setShowHidden(e.target.checked)
                navigate(listing?.path, e.target.checked)
              }}
            />
            {t('web.pickFolderShowHidden')}
          </label>
          <div className="flex-1" />
          <button
            type="button"
            data-web-dir-cancel=""
            onClick={cancel}
            className="px-3 py-1.5 text-[12px] rounded-md text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            data-web-dir-choose=""
            disabled={!listing || !!listing.error || loading || fetchFailed}
            onClick={choose}
            className="px-3 py-1.5 text-[12px] rounded-md bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-40"
          >
            {t('web.pickFolderChoose')}
          </button>
        </div>
      </div>
    </div>
  )
}
