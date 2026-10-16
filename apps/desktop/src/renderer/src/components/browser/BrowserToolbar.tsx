import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  ArrowRight,
  EllipsisVertical,
  FileText,
  Globe,
  LayoutGrid,
  Lock,
  RotateCw,
  Square,
  TriangleAlert,
  X,
  ZoomIn
} from 'lucide-react'
import {
  selectedTab,
  useBrowserTabsStore,
  type BrowserTabInfo,
  type BrowserViewMode
} from '../../stores/browserTabsStore'
import { resolveOmniboxInput, SEARCH_ENGINES, urlDisplayOf, type SearchEngineId } from './omnibox'
import { showMoreMenu } from './browserMenus'

const iconBtn =
  'flex-shrink-0 p-1.5 rounded-full text-text-secondary hover:bg-bg-hover/70 disabled:opacity-35 disabled:hover:bg-transparent transition-colors'

/**
 * 工具条 —— 标签条下面那一行：后退 / 前进 / 刷新、地址栏、视图切换、⋮ 菜单。
 * 一律作用于**选中的那一页**；单页视图与平铺墙共用（平铺墙里就是选中的那张卡片）。
 */
export function BrowserToolbar({
  engine,
  viewMode,
  onViewMode
}: {
  engine: SearchEngineId
  viewMode: BrowserViewMode
  onViewMode: (mode: BrowserViewMode) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tab = useBrowserTabsStore(selectedTab)
  const view = window.api.browserView

  return (
    <div
      className="flex-shrink-0 flex items-center gap-1 h-10 px-2 bg-bg-primary border-b border-border-secondary/40"
      data-browser-toolbar
    >
      <button
        className={iconBtn}
        disabled={!tab?.canGoBack}
        onClick={() => tab && void view.goBack(tab.id)}
        title={t('browser.back')}
        aria-label={t('browser.back')}
        data-browser-back
      >
        <ArrowLeft size={16} />
      </button>
      <button
        className={iconBtn}
        disabled={!tab?.canGoForward}
        onClick={() => tab && void view.goForward(tab.id)}
        title={t('browser.forward')}
        aria-label={t('browser.forward')}
        data-browser-forward
      >
        <ArrowRight size={16} />
      </button>
      {tab?.isLoading ? (
        <button
          className={iconBtn}
          onClick={() => void view.stop(tab.id)}
          title={t('browser.stop')}
          aria-label={t('browser.stop')}
          data-browser-stop
        >
          <X size={16} />
        </button>
      ) : (
        <button
          className={iconBtn}
          disabled={!tab || tab.url === 'about:blank'}
          onClick={() => tab && void view.reload(tab.id)}
          title={t('browser.refresh')}
          aria-label={t('browser.refresh')}
          data-browser-reload
        >
          <RotateCw size={15} />
        </button>
      )}

      <Omnibox tab={tab} engine={engine} />

      <button
        className={iconBtn}
        onClick={() => onViewMode(viewMode === 'single' ? 'wall' : 'single')}
        title={t(viewMode === 'single' ? 'browser.view.wall' : 'browser.view.single')}
        aria-label={t(viewMode === 'single' ? 'browser.view.wall' : 'browser.view.single')}
        data-browser-view-toggle={viewMode}
      >
        {viewMode === 'single' ? <LayoutGrid size={15} /> : <Square size={15} />}
      </button>
      <button
        className={iconBtn}
        onClick={() => void showMoreMenu({ tab, viewMode, onViewMode, t })}
        title={t('browser.menu.more')}
        aria-label={t('browser.menu.more')}
        data-browser-more
      >
        <EllipsisVertical size={16} />
      </button>
    </div>
  )
}

/**
 * 地址栏：未聚焦时显示主机名突出、其余变淡，前面一个安全标识；聚焦时是完整地址、整段选中。
 * 回车照 Chrome 的判断打开（像网址就打开，否则用搜索引擎搜）；Esc 放弃编辑。
 * ⌘L / ⌘T / 新标签页让它聚焦（store 的 omniboxFocusNonce）。
 */
function Omnibox({
  tab,
  engine
}: {
  tab: BrowserTabInfo | null
  engine: SearchEngineId
}): React.JSX.Element {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const focusNonce = useBrowserTabsStore((s) => s.omniboxFocusNonce)
  const navigateTab = useBrowserTabsStore((s) => s.navigateTab)
  const createTab = useBrowserTabsStore((s) => s.createTab)
  const zoomTab = useBrowserTabsStore((s) => s.zoomTab)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')

  const url = tab && tab.url !== 'about:blank' ? tab.url : ''

  /** 进入编辑：填上完整地址、整段选中（下一帧做，input 才挂上） */
  const beginEdit = (): void => {
    setText(url)
    setEditing(true)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }

  // ⌘L / ⌘T / 新开空白页：聚焦地址栏（nonce 只增不减；挂载时的值不触发）。
  // 放到下一帧再进编辑：新开的空白页这时才成为选中的那页，地址也才是它的
  const beginEditRef = useRef(beginEdit)
  useEffect(() => {
    beginEditRef.current = beginEdit
  })
  const lastNonce = useRef(focusNonce)
  useEffect(() => {
    if (focusNonce === lastNonce.current) return
    lastNonce.current = focusNonce
    const raf = requestAnimationFrame(() => beginEditRef.current())
    return () => cancelAnimationFrame(raf)
  }, [focusNonce])

  const submit = (): void => {
    const target = resolveOmniboxInput(text, engine)
    setEditing(false)
    inputRef.current?.blur()
    if (!target) return
    if (tab) navigateTab(tab.id, target)
    else createTab(target)
  }

  const display = urlDisplayOf(url)
  const placeholder = t('browser.omniboxPlaceholder', { engine: SEARCH_ENGINES[engine].name })
  const SecurityIcon =
    display.kind === 'secure'
      ? Lock
      : display.kind === 'insecure'
        ? TriangleAlert
        : display.kind === 'local'
          ? FileText
          : Globe

  return (
    <div
      className={`flex-1 min-w-0 flex items-center gap-2 h-8 mx-1 px-3 rounded-full transition-colors ${
        editing ? 'bg-bg-primary ring-2 ring-accent/50' : 'bg-bg-secondary hover:bg-bg-hover/60'
      }`}
      data-omnibox
    >
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setEditing(false)
              inputRef.current?.blur()
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          className="flex-1 min-w-0 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-tertiary"
          data-omnibox-input
        />
      ) : (
        <div
          className="flex-1 min-w-0 flex items-center gap-2 h-full cursor-text"
          onMouseDown={(e) => {
            e.preventDefault()
            beginEdit()
          }}
          data-omnibox-display={url}
        >
          {url ? (
            <>
              <span
                className={`flex-shrink-0 flex items-center gap-1 ${
                  display.kind === 'insecure' ? 'text-text-secondary' : 'text-text-tertiary'
                }`}
              >
                <SecurityIcon size={13} />
                {display.kind === 'insecure' && (
                  <span className="text-[12px]">{t('browser.notSecure')}</span>
                )}
              </span>
              <span className="min-w-0 truncate text-[13px]">
                <span className="text-text-primary">{display.host}</span>
                <span className="text-text-tertiary">{display.rest}</span>
              </span>
            </>
          ) : (
            <span className="truncate text-[13px] text-text-tertiary">{placeholder}</span>
          )}
        </div>
      )}
      {tab && tab.zoomPercent !== 100 && tab.url !== 'about:blank' && (
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => zoomTab(tab.id, 'reset')}
          className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] tabular-nums text-text-secondary hover:bg-bg-hover"
          title={t('browser.zoomIndicator', { pct: tab.zoomPercent })}
          data-browser-zoom={tab.zoomPercent}
        >
          <ZoomIn size={12} />
          {tab.zoomPercent}%
        </button>
      )}
    </div>
  )
}
