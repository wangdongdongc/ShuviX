import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Download } from 'lucide-react'
import { ChatHostContext, type ChatAppearance } from '../../host/chatHostContext'
import { useThemeId } from '../chat/useThemeId'
import {
  copyPngToClipboard,
  downloadBlob,
  rasterizeFigure,
  svgFileBlob,
  type FigureExportSource,
  type StandaloneSvg
} from './figureExport'
import {
  DEFAULT_FIGURE_PREFS,
  FIGURE_EXTENSION,
  effectiveBackground,
  effectiveScale,
  figureFileBase,
  normalizeFigurePrefs,
  rasterSize,
  type FigureExportPrefs,
  type FigureFormat,
  type FigureScheme
} from './figureExportPure'

/**
 * 图导出面板 —— 对话里的 ```svg / svg 产物 / mermaid 图卡，以及笔记本里的同两种图，共用这一个。
 *
 * 一张面板只认一个 FigureExportSource：图从哪来、怎么按某套主题重新取色是图源的事，面板只管
 * 选项、预览、落盘与剪贴板。设计稿与取舍（缺省「当前主题 + 填充」、JPG 强制底色、记住上一次的
 * 选择）见 figureExportPure.ts 的 DEFAULT_FIGURE_PREFS。
 */

const PREFS_KEY = 'shuvix.figureExport.prefs'
const PANEL_WIDTH = 300
const GAP = 6

/** 偏好按查看者记在 localStorage：读写都可能抛（隐私窗口、存储被禁），抛了就当没有 */
function loadPrefs(): FigureExportPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    return raw ? normalizeFigurePrefs(JSON.parse(raw)) : DEFAULT_FIGURE_PREFS
  } catch {
    return DEFAULT_FIGURE_PREFS
  }
}

function savePrefs(prefs: FigureExportPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // 存不下就只在这一次生效
  }
}

/**
 * 配色 → 要挂的主题 id。浅色 / 深色取用户在外观里设的那两套（宿主不给就用 GitHub 那一对）——
 * 用户切到浅色模式时看到的是哪套，导出的「浅色」就是哪套。
 */
export function figureThemeId(
  scheme: FigureScheme,
  rootThemeId: string,
  appearance: Pick<ChatAppearance, 'lightTheme' | 'darkTheme'> | undefined
): string {
  if (scheme === 'light') return appearance?.lightTheme || 'github-light'
  if (scheme === 'dark') return appearance?.darkTheme || 'github-dark'
  return rootThemeId
}

interface SegmentOption<V extends string | number> {
  value: V
  label: string
  disabled?: boolean
}

function Segmented<V extends string | number>({
  name,
  label,
  value,
  options,
  onChange
}: {
  name: string
  label: string
  value: V
  options: SegmentOption<V>[]
  onChange: (v: V) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-text-secondary">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="inline-flex rounded-md border border-border-primary overflow-hidden"
      >
        {options.map((o, i) => {
          const checked = o.value === value
          return (
            <button
              key={String(o.value)}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={o.disabled}
              data-figure-option={`${name}:${o.value}`}
              onClick={() => onChange(o.value)}
              className={`px-2 py-[3px] text-[11px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                i > 0 ? 'border-l border-border-secondary' : ''
              } ${
                checked
                  ? 'bg-accent/15 text-accent'
                  : 'text-text-secondary hover:bg-bg-hover enabled:hover:text-text-primary'
              }`}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

type BuildState = {
  key: string
  source: FigureExportSource
  fig?: StandaloneSvg
  error?: string
}

export function FigureExportPanel({
  source,
  anchor,
  onClose
}: {
  source: FigureExportSource
  /** 面板对齐的那颗按钮（对话图卡的工具栏按钮，或笔记本 widget 上的悬浮按钮） */
  anchor: HTMLElement
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const appearance = useContext(ChatHostContext)?.appearance
  const rootThemeId = useThemeId()
  const [prefs, setPrefsState] = useState<FigureExportPrefs>(loadPrefs)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const setPrefs = (patch: Partial<FigureExportPrefs>): void => {
    const next = { ...prefs, ...patch }
    savePrefs(next)
    setPrefsState(next)
    setActionError(null)
  }

  const background = effectiveBackground(prefs)
  const themeId = figureThemeId(prefs.scheme, rootThemeId, appearance)
  const buildKey = `${prefs.scheme}\u0000${themeId}\u0000${background}`

  // 同一组（配色 × 底色）只建一次：来回点选项不重算，下载 / 复制拿的也是预览那一份。
  // 缓存跟着**图源**走：同一个面板实例换了一张图（笔记本里开着面板去点另一张图的按钮），
  // 旧图的产物不能顶着新图的文件名被导出去
  const caches = useRef(new WeakMap<FigureExportSource, Map<string, Promise<StandaloneSvg>>>())
  const getFigure = useCallback((): Promise<StandaloneSvg> => {
    let cache = caches.current.get(source)
    if (!cache) {
      cache = new Map()
      caches.current.set(source, cache)
    }
    let job = cache.get(buildKey)
    if (!job) {
      job = Promise.resolve().then(() =>
        source.build({ scheme: prefs.scheme, themeId, background })
      )
      const owner = cache
      owner.set(buildKey, job)
      job.catch(() => owner.delete(buildKey))
    }
    return job
  }, [buildKey, source, prefs.scheme, themeId, background])

  const [built, setBuilt] = useState<BuildState | null>(null)
  useEffect(() => {
    let alive = true
    getFigure().then(
      (fig) => alive && setBuilt({ key: buildKey, source, fig }),
      (e: unknown) =>
        alive &&
        setBuilt({ key: buildKey, source, error: e instanceof Error ? e.message : String(e) })
    )
    return () => {
      alive = false
    }
  }, [buildKey, source, getFigure])
  const current = built?.key === buildKey && built.source === source ? built : null
  const fig = current?.fig ?? null

  const previewUrl = useMemo(
    () => (fig ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(fig.svg)}` : null),
    [fig]
  )

  // ── 动作 ──
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const fileName = `${figureFileBase(source.name, t('figureExport.defaultName'))}.${FIGURE_EXTENSION[prefs.format]}`

  const download = async (): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      const f = await getFigure()
      const blob =
        prefs.format === 'svg'
          ? svgFileBlob(f)
          : await rasterizeFigure(f, prefs.format, prefs.scale)
      downloadBlob(blob, fileName)
      onClose()
    } catch (e) {
      if (mounted.current) {
        setActionError(
          t('figureExport.failed', { error: e instanceof Error ? e.message : String(e) })
        )
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const copy = async (): Promise<void> => {
    setActionError(null)
    // 在点击这一拍里就把 Promise 交给剪贴板（见 copyPngToClipboard）
    const png = getFigure().then((f) => rasterizeFigure(f, 'png', prefs.scale))
    try {
      await copyPngToClipboard(png)
      if (!mounted.current) return
      setCopied(true)
      setTimeout(() => mounted.current && setCopied(false), 1500)
    } catch {
      if (mounted.current) setActionError(t('figureExport.copyFailed'))
    }
  }

  // ── 定位：fixed + 与按钮右对齐，下方放不下就翻到上方。坐标直接写在节点上（布局前，无首帧跳动）──
  const panelRef = useRef<HTMLDivElement>(null)
  const downloadRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const place = (): void => {
      const panel = panelRef.current
      if (!panel) return
      // 按钮被卸掉了（虚拟列表把卡片滚出去、笔记本重建了 widget）：面板没有可对齐的东西，收起
      if (!anchor.isConnected) {
        onClose()
        return
      }
      const r = anchor.getBoundingClientRect()
      const h = panel.offsetHeight
      const left = Math.min(Math.max(8, r.right - PANEL_WIDTH), window.innerWidth - PANEL_WIDTH - 8)
      const below = window.innerHeight - r.bottom - GAP
      const top = below >= h || r.top - GAP < h ? r.bottom + GAP : r.top - GAP - h
      panel.style.left = `${left}px`
      panel.style.top = `${Math.max(8, top)}px`
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    if (ro && panelRef.current) ro.observe(panelRef.current)
    // 按钮被摘掉不一定伴随滚动或缩放：笔记本里光标一进围栏，widget 就整个换成源码。
    // 观察整棵 body 的增删，只做一次 isConnected 判断，代价可以忽略
    const mo =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            if (!anchor.isConnected) onClose()
          })
        : null
    mo?.observe(document.body, { childList: true, subtree: true })
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      ro?.disconnect()
      mo?.disconnect()
    }
  }, [anchor, onClose])

  // 图第一次出来时把焦点交给「下载」（键盘用户回车就是导出）。不能在挂载时给：那一刻按钮还
  // 因为图没建好而 disabled，focus() 落空。用户已经在面板里点过别的控件就不抢
  const focusedOnce = useRef(false)
  useEffect(() => {
    if (!fig || focusedOnce.current) return
    focusedOnce.current = true
    if (!panelRef.current?.contains(document.activeElement)) downloadRef.current?.focus()
  }, [fig])

  // 外面按下 / Esc 收起
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || anchor.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
      anchor.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [anchor, onClose])

  // ── 尺寸说明 ──
  const dims = (() => {
    if (!fig) return ''
    const w = Math.round(fig.width)
    const h = Math.round(fig.height)
    if (prefs.format === 'svg') return `${t('figureExport.vector')} · ${w} × ${h}`
    const size = rasterSize(
      fig.width,
      fig.height,
      effectiveScale(fig.width, fig.height, prefs.scale)
    )
    return `${size.width} × ${size.height} px`
  })()

  const note =
    prefs.format === 'jpg'
      ? t('figureExport.noteJpg')
      : prefs.format === 'svg'
        ? t('figureExport.noteSvg')
        : ''

  const formats: SegmentOption<FigureFormat>[] = [
    { value: 'svg', label: 'SVG' },
    { value: 'png', label: 'PNG' },
    { value: 'jpg', label: 'JPG' }
  ]

  return createPortal(
    <div
      ref={panelRef}
      data-figure-export-panel
      role="dialog"
      aria-label={t('figureExport.button')}
      style={{ position: 'fixed', width: PANEL_WIDTH, zIndex: 50, left: -9999, top: 0 }}
      className="picker-panel rounded-lg border border-border-primary bg-bg-secondary shadow-lg p-3 flex flex-col gap-2.5"
    >
      {/* 预览：透明底显示成棋盘格，一眼看得出导出来有没有底色 */}
      <div
        data-figure-preview={current?.error ? 'error' : fig ? 'ready' : 'building'}
        className="rounded-md border border-border-secondary flex items-center justify-center p-2 min-h-[96px]"
        style={
          background
            ? undefined
            : {
                backgroundImage:
                  'repeating-conic-gradient(var(--color-bg-hover) 0% 25%, transparent 0% 50%)',
                backgroundSize: '12px 12px'
              }
        }
      >
        {previewUrl ? (
          <img
            src={previewUrl}
            alt=""
            className="block max-w-full max-h-[160px] object-contain"
            draggable={false}
          />
        ) : current?.error ? (
          <span className="text-[11px] text-orange-400 text-center break-words">
            {t('figureExport.failed', { error: current.error })}
          </span>
        ) : (
          <span className="text-[11px] text-text-tertiary">{t('figureExport.building')}</span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 text-[10px] text-text-tertiary -mt-1">
        <span className="truncate" data-figure-filename title={fileName}>
          {fileName}
        </span>
        <span className="flex-shrink-0 tabular-nums" data-figure-dims>
          {dims}
        </span>
      </div>

      <Segmented
        name="format"
        label={t('figureExport.format')}
        value={prefs.format}
        options={formats}
        onChange={(format) => setPrefs({ format })}
      />
      <Segmented
        name="scheme"
        label={t('figureExport.scheme')}
        value={prefs.scheme}
        options={[
          { value: 'current', label: t('figureExport.schemeCurrent') },
          { value: 'light', label: t('figureExport.schemeLight') },
          { value: 'dark', label: t('figureExport.schemeDark') }
        ]}
        onChange={(scheme) => setPrefs({ scheme })}
      />
      <Segmented
        name="background"
        label={t('figureExport.background')}
        value={background ? 'fill' : 'none'}
        options={[
          { value: 'none', label: t('figureExport.bgNone'), disabled: prefs.format === 'jpg' },
          { value: 'fill', label: t('figureExport.bgFill') }
        ]}
        onChange={(v) => setPrefs({ background: v === 'fill' })}
      />
      <Segmented
        name="scale"
        label={t('figureExport.scale')}
        value={prefs.scale}
        options={([1, 2, 3] as const).map((s) => ({
          value: s,
          label: `${s}x`,
          disabled: prefs.format === 'svg'
        }))}
        onChange={(scale) => setPrefs({ scale })}
      />

      {note && <div className="text-[10px] text-text-tertiary leading-snug">{note}</div>}
      {actionError && (
        <div data-figure-action-error className="text-[10px] text-orange-400 break-words">
          {actionError}
        </div>
      )}

      <div className="flex gap-2 pt-0.5">
        <button
          type="button"
          data-figure-copy
          onClick={() => void copy()}
          disabled={!fig}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-md border border-border-primary px-2 py-1.5 text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors disabled:opacity-50"
        >
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          <span>{copied ? t('figureExport.copied') : t('figureExport.copy')}</span>
        </button>
        <button
          type="button"
          ref={downloadRef}
          data-figure-download
          onClick={() => void download()}
          disabled={!fig || busy}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-md border border-accent/50 bg-accent/15 px-2 py-1.5 text-[11px] text-accent hover:bg-accent/25 transition-colors disabled:opacity-50"
        >
          <Download size={12} />
          <span>{t('figureExport.download')}</span>
        </button>
      </div>
    </div>,
    document.body
  )
}

/**
 * 图卡工具栏上的「导出」按钮 —— 与旁边的「源码 / 图」切换同一个样式。
 * `getSource` 在点开的那一刻才调：图源闭包住的是此刻屏幕上的那份标记。
 */
export function FigureExportButton({
  getSource
}: {
  getSource: () => FigureExportSource | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState<{ source: FigureExportSource; anchor: HTMLElement } | null>(null)
  const close = useCallback(() => setOpen(null), [])

  return (
    <>
      <button
        type="button"
        data-figure-export
        aria-expanded={!!open}
        onClick={(e) => {
          if (open) {
            setOpen(null)
            return
          }
          const source = getSource()
          if (source) setOpen({ source, anchor: e.currentTarget })
        }}
        className={`flex items-center gap-1 text-[10px] transition-colors ${
          open ? 'text-accent' : 'text-text-tertiary hover:text-text-secondary'
        }`}
        title={t('figureExport.button')}
      >
        <Download size={10} />
        <span>{t('figureExport.button')}</span>
      </button>
      {open && <FigureExportPanel source={open.source} anchor={open.anchor} onClose={close} />}
    </>
  )
}
