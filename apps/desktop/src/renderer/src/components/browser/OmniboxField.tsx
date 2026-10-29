import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Globe, History, Lock, Settings, TriangleAlert, ZoomIn } from 'lucide-react'
import {
  internalPageOfTab,
  useBrowserTabsStore,
  type BrowserTabInfo,
  type BrowserViewMode
} from '../../stores/browserTabsStore'
import { resolveOmniboxInput, SEARCH_ENGINES, urlDisplayOf, type SearchEngineId } from './omnibox'
import { buildOmniboxMatches, type OmniboxMatch } from './omniboxSuggest'
import { useOmniboxSuggestions } from './useOmniboxSuggestions'
import { OmniboxPopup } from './OmniboxPopup'
import { SiteInfoBubble } from './SiteInfoBubble'

const POPUP_ID = 'omnibox-suggestions'
const NO_MATCHES = { matches: [] as OmniboxMatch[], inline: null as string | null }

/** 这一页在页面区里是不是原生页面（空白页、内部页面、错误页是外壳的 DOM，不用截图顶） */
function showsNativePage(tab: BrowserTabInfo | null): tab is BrowserTabInfo {
  return (
    !!tab && !!tab.url && tab.url !== 'about:blank' && !internalPageOfTab(tab) && !tab.loadError
  )
}

/** 页面区宽度 × devicePixelRatio（截图按它抓，顶上去与原生页面一样清楚） */
function pageAreaPixelWidth(): number {
  const area = document.querySelector('[data-page-area]')?.getBoundingClientRect()
  return Math.round((area?.width || window.innerWidth) * window.devicePixelRatio)
}

/**
 * 地址栏（Chrome 的 omnibox）：未聚焦时显示主机名突出、其余变淡，前面一个安全标识；聚焦时是完整地址、整段选中。
 *
 * 一开始打字就有下拉建议（OmniboxPopup，组合规则见 omniboxSuggest.ts）：第一行是回车会去的地方，
 * ↑ / ↓（或 Tab / ⇧Tab）在行间走、地址栏跟着显示那一行；Esc 先退回自己敲的字（撤掉选的行与内联补全），
 * 再按一次放弃编辑；
 * 选中一条历史时 ⇧Delete（或行尾的 ×）把它从历史里删掉。敲过的网站会**内联补全**（`git` → `github.com`，
 * 补上的部分选中）：接着敲对得上的字照样补，退格只删补上的那段、这一下不再补，←/→/Home/End 或点一下
 * 输入框就把补上的字收下。输入法组字时不补、不响应回车。
 *
 * 回车 / 点一行：网址记成 typed、搜索记成 generated（历史用，见 shared/browserHistory.ts）；「切换到此标签页」
 * 那行只是选中那个 tab。⌘L / ⌘T / 新标签页让它聚焦（store 的 omniboxFocusNonce）。
 */
export function Omnibox({
  tab,
  engine,
  searchSuggest,
  viewMode
}: {
  tab: BrowserTabInfo | null
  engine: SearchEngineId
  /** 设置里开着「显示搜索建议」 */
  searchSuggest: boolean
  viewMode: BrowserViewMode
}): React.JSX.Element {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const focusNonce = useBrowserTabsStore((s) => s.omniboxFocusNonce)
  const tabs = useBrowserTabsStore((s) => s.tabs)
  const navigateTab = useBrowserTabsStore((s) => s.navigateTab)
  const createTab = useBrowserTabsStore((s) => s.createTab)
  const activateTab = useBrowserTabsStore((s) => s.activateTab)
  const zoomTab = useBrowserTabsStore((s) => s.zoomTab)
  const setPageCover = useBrowserTabsStore((s) => s.setPageCover)
  const covered = useBrowserTabsStore((s) => !!s.pageCover)

  const [editing, setEditing] = useState(false)
  /** 用户敲的字（不含内联补上的那段） */
  const [userText, setUserText] = useState('')
  /** 进编辑以来敲过字没有：敲过才有下拉建议（照 Chrome，光聚焦不弹） */
  const [typed, setTyped] = useState(false)
  /** 这一下能不能内联补全：刚删过字、组字中、光标不在末尾时不能 */
  const [allowInline, setAllowInline] = useState(false)
  /** 方向键选到的行（0 = 默认那一行） */
  const [selected, setSelected] = useState(0)
  /** 打分用的「此刻」：进编辑时定一次（最近访问按天算权重，不必每个键都取时钟） */
  const [now, setNow] = useState(0)
  /** 站点信息气泡开着的是哪个 tab 的哪个地址（换了 tab / 地址就当它关了） */
  const [siteInfoFor, setSiteInfoFor] = useState<{ tabId: string; url: string } | null>(null)
  const siteInfoOpen = !!tab && siteInfoFor?.tabId === tab.id && siteInfoFor.url === tab.url

  const { history, search, removeHistory } = useOmniboxSuggestions(
    editing && typed ? userText : '',
    engine,
    searchSuggest
  )
  const result = useMemo(
    () =>
      editing && typed
        ? buildOmniboxMatches({
            text: userText,
            engine,
            history,
            searchSuggestions: search,
            tabs,
            selectedTabId: tab?.id ?? null,
            allowInline,
            now
          })
        : NO_MATCHES,
    [editing, typed, userText, engine, history, search, tabs, tab?.id, allowInline, now]
  )
  const { matches } = result
  const sel = Math.min(selected, Math.max(0, matches.length - 1))
  /** 想开下拉：在编辑、敲过字、有建议 */
  const wantPopup = editing && typed && matches.length > 0
  /** 真开着：页面区已经换成截图（不然原生页面会把它盖住） */
  const popupShown = wantPopup && covered
  const inlineShown = sel === 0 && result.inline !== null
  const value = sel > 0 && matches[sel] ? matches[sel].fill : (result.inline ?? userText)

  // 内联补全：补上的那段选中（下一个键要么接着对上、要么把它替换掉）
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el || !inlineShown || document.activeElement !== el) return
    el.setSelectionRange(userText.length, value.length)
  }, [inlineShown, userText.length, value])

  // ====== 页面区的截图：下拉要开时先抓一张顶上，抓到了才开（与站点信息气泡同一个机制） ======
  /** null = 没顶；pending = 正在抓；set = 顶着 */
  const coverState = useRef<'pending' | 'set' | null>(null)
  useEffect(() => {
    if (!wantPopup) {
      if (coverState.current) {
        coverState.current = null
        setPageCover(null)
      }
      return
    }
    if (coverState.current) return
    const tabId = tab?.id ?? ''
    if (!showsNativePage(tab) || viewMode === 'wall') {
      // 页面区本来就是 DOM（空白页、内部页面、错误页），或平铺墙（卡片用各自的快照）：不用抓
      coverState.current = 'set'
      setPageCover({ tabId, snapshot: '' })
      return
    }
    coverState.current = 'pending'
    void window.api.browserView
      .capture(tabId, pageAreaPixelWidth())
      .catch(() => '')
      .then((snapshot) => {
        if (coverState.current !== 'pending') return
        coverState.current = 'set'
        setPageCover({ tabId, snapshot })
      })
  }, [wantPopup, tab, viewMode, setPageCover])
  useEffect(
    () => () => {
      if (coverState.current) useBrowserTabsStore.getState().setPageCover(null)
    },
    []
  )

  // 站点信息气泡因为换了 tab / 地址而失效：把页面区的截图撤掉（views 回到页面区）
  useEffect(() => {
    if (siteInfoFor && !siteInfoOpen) {
      const raf = requestAnimationFrame(() => {
        setSiteInfoFor(null)
        setPageCover(null)
      })
      return () => cancelAnimationFrame(raf)
    }
    return undefined
  }, [siteInfoFor, siteInfoOpen, setPageCover])

  /**
   * 打开站点信息气泡：先按页面区的宽度抓一张截图顶上（原生页面会盖住 DOM 气泡），再开气泡。
   * 抓不到图也照开 —— 页面区那段时间空着而已。
   */
  const openSiteInfo = async (): Promise<void> => {
    if (!tab) return
    const snapshot = await window.api.browserView
      .capture(tab.id, pageAreaPixelWidth())
      .catch(() => '')
    setPageCover({ tabId: tab.id, snapshot })
    setSiteInfoFor({ tabId: tab.id, url: tab.url })
  }
  const closeSiteInfo = (): void => {
    setSiteInfoFor(null)
    setPageCover(null)
  }

  const url = tab && tab.url !== 'about:blank' ? tab.url : ''

  /** 进入编辑：填上完整地址、整段选中（下一帧做，input 才挂上） */
  const beginEdit = (): void => {
    setUserText(url)
    setTyped(false)
    setAllowInline(false)
    setSelected(0)
    setNow(Date.now())
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

  const endEdit = (): void => {
    setEditing(false)
    setTyped(false)
    inputRef.current?.blur()
  }

  /** 打开一行建议；没有建议（没敲过字直接回车）时照地址栏里的字打开 */
  const openMatch = (match: OmniboxMatch | undefined): void => {
    const fallback = match ? null : resolveOmniboxInput(value, engine)
    endEdit()
    if (match?.kind === 'tab') {
      activateTab(match.tabId)
      return
    }
    const target = match ? match.url : fallback
    if (!target) return
    const transition = match?.kind === 'search' ? 'generated' : 'typed'
    if (tab) navigateTab(tab.id, target, transition)
    else createTab(target, transition)
  }

  /** 把内联补上的字（或方向键选到的那一行的字）收下，当成自己敲的 */
  const acceptShown = (): void => {
    if (!inlineShown && sel === 0) return
    setUserText(value)
    setSelected(0)
    setAllowInline(false)
  }

  const removeAt = (index: number): void => {
    const match = matches[index]
    if (match?.kind !== 'history') return
    removeHistory(match.url)
    if (index === sel) setSelected(Math.max(0, index - 1))
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    switch (e.key) {
      case 'Enter':
        e.preventDefault()
        openMatch(matches[sel])
        return
      case 'Escape':
        e.preventDefault()
        // 先退回自己敲的字（方向键选的行、内联补上的那段都撤掉），再按一次才放弃编辑（照 Chrome）
        if (popupShown && (sel > 0 || inlineShown)) {
          setSelected(0)
          setAllowInline(false)
        } else endEdit()
        return
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Tab': {
        if (!popupShown || e.altKey || e.metaKey || e.ctrlKey) return
        e.preventDefault()
        const down = e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)
        setSelected(Math.min(matches.length - 1, Math.max(0, sel + (down ? 1 : -1))))
        return
      }
      case 'Delete':
        if (e.shiftKey && popupShown && matches[sel]?.kind === 'history') {
          e.preventDefault()
          removeAt(sel)
        }
        return
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End':
        acceptShown()
        return
    }
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
          : display.kind === 'internal'
            ? tab && internalPageOfTab(tab) === 'history'
              ? History
              : Settings
            : Globe
  /** 有站点信息可看的页面（网页与本地文件）：安全图标是个按钮 */
  const hasSiteInfo =
    display.kind === 'secure' || display.kind === 'insecure' || display.kind === 'local'

  return (
    <div
      className={`relative flex-1 min-w-0 flex items-center gap-2 h-8 mx-1 px-3 rounded-full transition-colors ${
        editing ? 'bg-bg-primary ring-2 ring-accent/50' : 'bg-bg-secondary hover:bg-bg-hover/60'
      }`}
      data-omnibox
    >
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={popupShown}
          aria-controls={POPUP_ID}
          aria-autocomplete="both"
          aria-activedescendant={popupShown ? `${POPUP_ID}-${sel}` : undefined}
          value={value}
          onChange={(e) => {
            const el = e.target
            const native = e.nativeEvent as InputEvent
            const deleting =
              typeof native.inputType === 'string' && native.inputType.startsWith('delete')
            const atEnd =
              el.selectionStart === el.value.length && el.selectionEnd === el.value.length
            setUserText(el.value)
            setTyped(true)
            setSelected(0)
            setAllowInline(!deleting && !native.isComposing && atEnd)
          }}
          onMouseDown={acceptShown}
          onBlur={() => {
            setEditing(false)
            setTyped(false)
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
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
              {hasSiteInfo ? (
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => (siteInfoOpen ? closeSiteInfo() : void openSiteInfo())}
                  className={`flex-shrink-0 -ml-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-full hover:bg-bg-hover ${
                    display.kind === 'insecure' ? 'text-text-secondary' : 'text-text-tertiary'
                  }`}
                  title={t('browser.siteInfo.button')}
                  aria-label={t('browser.siteInfo.button')}
                  data-site-info-button
                >
                  <SecurityIcon size={13} />
                  {display.kind === 'insecure' && (
                    <span className="text-[12px]">{t('browser.notSecure')}</span>
                  )}
                </button>
              ) : (
                <span className="flex-shrink-0 flex items-center text-text-tertiary">
                  <SecurityIcon size={13} />
                </span>
              )}
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
      {popupShown && (
        <OmniboxPopup
          id={POPUP_ID}
          matches={matches}
          selected={sel}
          text={userText}
          engine={engine}
          onPick={(index) => openMatch(matches[index])}
          onRemove={removeAt}
        />
      )}
      {siteInfoOpen && tab && <SiteInfoBubble tab={tab} onClose={closeSiteInfo} />}
    </div>
  )
}
