/**
 * 应用内看图（2026-11-20 用户裁定，按确认过的草图做）：点一张图，在当前窗口上叠一层深色看，不再开独立窗口 /
 * 新标签页（那样来回切换不方便）。图从哪来见 imageViewerStore；每个窗口由宿主挂一个（桌面 SessionRuntime）。
 *
 *  - **桌面**（`touch` 关）：顶栏 = 名字 · 尺寸 · 第几张 | 缩放比例（点了在「适合窗口 / 实际大小」间切换）、缩小、放大、
 *    复制、下载、在独立窗口打开（宿主给了 `onOpenInWindow` 且这张有原图路径才有）、关闭；左右箭头与底部缩略图条
 *    （一组多于一张时）。滚轮 / 触控板捏合以指针处为中心缩放，放大后拖动平移，双击在适合窗口与 1:1 间切换。
 *    Esc / 点空白处关闭，← → 翻页，+ − 0 缩放。
 *  - **手机**（`touch` 开）：全屏黑底，顶栏 = 关闭 · 第几张 · 分享（能分享文件就分享，不能就下载）。双指缩放、
 *    放大后单指拖、左右滑翻页、下滑关闭、双击放大 / 还原；打开时压一条历史记录，返回手势关掉它。
 *
 * 地址：`src`（`data:` 等）直接用，否则经注入的 mediaUrl seam 解析（与对话里的缩略图同一条路），不读 base64 进 state。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  ImageOff,
  Share,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { useMediaUrl } from '../../host/mediaUrl'
import { useImageViewerStore, type ViewerImage } from '../../stores/imageViewerStore'
import {
  clampOffset,
  fitScale,
  isZoomedIn,
  stepScale,
  zoomAt,
  type Size,
  type View
} from './viewerMath'

/** 历史记录上的记号（手机：返回手势关掉看图） */
export const IMAGE_VIEWER_HISTORY_MARK = 'shuvixImageViewer'

/** 左右滑多远算翻页、下滑多远算关闭（CSS px） */
const SWIPE_PAGE_PX = 60
const SWIPE_CLOSE_PX = 100
/** 两次点按多久之内算双击 */
const DOUBLE_TAP_MS = 300
/** 按下到抬起挪动不到这么多算「点」 */
const TAP_SLOP_PX = 6

export interface ImageViewerProps {
  /** 手机样式与手势（宿主按布局给） */
  touch?: boolean
  /** 「在独立窗口打开」：宿主给了才有这个按钮（桌面开预览窗口，web 开新标签页） */
  onOpenInWindow?: (image: ViewerImage) => void
  /**
   * 复制 / 另存由宿主做（桌面：页面读不到 `shuvix-preview://` 的字节，交主进程写剪贴板、弹另存为）。只用于经 mediaUrl
   * 解析的图（有 `path`）；`src` 给的（`data:`）以及没给这两个的宿主，页面自己读字节
   */
  onCopy?: (image: ViewerImage) => Promise<boolean>
  onSave?: (image: ViewerImage) => Promise<void>
}

/** 宿主的复制 / 另存（经 Overlay → Body 传下去） */
type HostActions = Pick<ImageViewerProps, 'onOpenInWindow' | 'onCopy' | 'onSave'>

export function ImageViewer({
  touch = false,
  insetLeft = 0,
  ...actions
}: ImageViewerProps & {
  /** 顶栏左侧让出的宽度（macOS 隐藏标题栏时左上角是窗口按钮） */
  insetLeft?: number
}): React.JSX.Element | null {
  const images = useImageViewerStore((s) => s.images)
  const nonce = useImageViewerStore((s) => s.nonce)
  if (images.length === 0) return null
  // Overlay 不按 nonce 重挂（开着时又点开一组：历史记录只压一次，不和退回的那条打架）；Body 按 nonce + 第几张重挂
  return createPortal(
    <Overlay nonce={nonce} touch={touch} insetLeft={insetLeft} actions={actions} />,
    document.body
  )
}

function Overlay({
  nonce,
  touch,
  insetLeft,
  actions
}: {
  nonce: number
  touch: boolean
  insetLeft: number
  actions: HostActions
}): React.JSX.Element {
  const images = useImageViewerStore((s) => s.images)
  const index = useImageViewerStore((s) => s.index)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 手机：自己压了一条历史记录、还没退掉 */
  const pushedRef = useRef(false)

  // 手机：压一条历史记录（带着原来的记号，别的页面的判断不受影响），返回手势退掉它就关
  useEffect(() => {
    if (!touch) return
    const state: unknown = window.history.state
    window.history.pushState(
      { ...(state && typeof state === 'object' ? state : {}), [IMAGE_VIEWER_HISTORY_MARK]: true },
      ''
    )
    pushedRef.current = true
    const onPop = (): void => {
      const now = window.history.state as Record<string, unknown> | null
      if (now?.[IMAGE_VIEWER_HISTORY_MARK]) return
      pushedRef.current = false
      useImageViewerStore.getState().close()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // 别处关掉的（store.close）：把自己那条记录退掉
      if (pushedRef.current) {
        pushedRef.current = false
        window.history.back()
      }
    }
  }, [touch])

  // 焦点：打开时拿走（输入框里的字不跟着键盘走），关掉时还回去
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    rootRef.current?.focus()
    return () => before?.focus?.()
  }, [])

  const close = useCallback((): void => {
    if (touch && pushedRef.current) {
      window.history.back() // popstate 里关
      return
    }
    useImageViewerStore.getState().close()
  }, [touch])

  const image = images[index]
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={image?.name}
      data-image-viewer={touch ? 'touch' : 'desktop'}
      // titlebar-no-drag：窗口顶上那条拖拽带（macOS）压在下面时，顶栏的按钮照样点得到
      className={`titlebar-no-drag fixed inset-0 z-[1100] flex flex-col text-white outline-none select-none ${
        touch ? 'bg-black' : 'bg-black/85'
      }`}
    >
      {image && (
        <Body
          key={`${nonce}:${index}`}
          image={image}
          images={images}
          index={index}
          touch={touch}
          insetLeft={insetLeft}
          close={close}
          actions={actions}
        />
      )}
    </div>
  )
}

/** 一张图的地址：有 src 用 src（不去解析），否则经 mediaUrl seam */
function useViewerUrl(image: ViewerImage): string | null {
  const resolved = useMediaUrl(
    image.sessionId || 'library',
    image.path ?? '',
    image.mimeType,
    !image.src && !!image.path
  )
  return image.src ?? resolved
}

type CopyState = 'idle' | 'copied' | 'failed'

function Body({
  image,
  images,
  index,
  touch,
  insetLeft,
  close,
  actions
}: {
  image: ViewerImage
  images: ViewerImage[]
  index: number
  touch: boolean
  insetLeft: number
  close: () => void
  actions: HostActions
}): React.JSX.Element {
  const { onOpenInWindow, onCopy, onSave } = actions
  /** 这张由宿主复制 / 另存（经 mediaUrl 解析的图） */
  const viaHost = !image.src && !!image.path
  const { t } = useTranslation()
  const url = useViewerUrl(image)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 })
  const [natural, setNatural] = useState<Size | null>(null)
  const [failed, setFailed] = useState(false)
  /** null = 适合窗口（窗口变了跟着变） */
  const [view, setView] = useState<View | null>(null)
  /** 没放大时手指拖着图走（手机翻页 / 下滑关闭的手感） */
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const many = images.length > 1

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = (): void => setStage({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fit = natural ? fitScale(natural, stage) : 1
  const shown: View = view ?? { scale: fit, x: 0, y: 0 }
  const zoomed = natural ? isZoomedIn(shown, natural, stage) : false

  // 用最新值的引用（事件处理器挂一次，读的是这里）
  const latest = useRef({ shown, natural, stage, fit, zoomed })
  latest.current = { shown, natural, stage, fit, zoomed }

  const zoomTo = useCallback((next: number, point?: { x: number; y: number }): void => {
    const { shown: cur, natural: nat, stage: st } = latest.current
    if (!nat) return
    const v = zoomAt(cur, next, point ?? { x: 0, y: 0 }, nat, st)
    setView(v.scale <= fitScale(nat, st) + 1e-6 ? null : v)
  }, [])

  /** 适合窗口 ↔ 实际大小（小图本来就是实际大小 → 放大一倍） */
  const toggleZoom = useCallback(
    (point?: { x: number; y: number }): void => {
      const { zoomed: z, fit: f } = latest.current
      if (z) setView(null)
      else zoomTo(f < 1 ? 1 : 2, point)
    },
    [zoomTo]
  )

  const go = (delta: number): void => {
    useImageViewerStore.getState().go(index + delta)
  }

  // 键盘：Esc 关、← → 翻页、+ − 0 缩放（捕获阶段，不让应用的快捷键先拿到）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      let handled = true
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowLeft' && images.length > 1) go(-1)
      else if (e.key === 'ArrowRight' && images.length > 1) go(1)
      else if (e.key === '+' || e.key === '=') zoomTo(stepScale(latest.current.shown.scale, 1))
      else if (e.key === '-' || e.key === '_') zoomTo(stepScale(latest.current.shown.scale, -1))
      else if (e.key === '0') setView(null)
      else handled = false
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [close, images.length, index, zoomTo])

  // 滚轮 / 触控板捏合：以指针处为中心缩放（要能 preventDefault，所以不走 React 的被动监听）
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const point = {
        x: e.clientX - rect.left - rect.width / 2,
        y: e.clientY - rect.top - rect.height / 2
      }
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))
      zoomTo(latest.current.shown.scale * k, point)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomTo])

  // 指针：拖动平移、双指缩放、手机滑动翻页 / 下滑关闭、点空白关闭、双击（含手机双点）
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{
    startX: number
    startY: number
    moved: number
    pinchDist: number
    lastTap: number
    onImage: boolean
  }>({ startX: 0, startY: 0, moved: 0, pinchDist: 0, lastTap: 0, onImage: false })

  const pointOf = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 }
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (pointers.current.size === 1) {
      g.startX = e.clientX
      g.startY = e.clientY
      g.moved = 0
      g.onImage = (e.target as HTMLElement).hasAttribute('data-image-viewer-image')
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      g.pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
      setDrag(null)
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    g.moved = Math.max(g.moved, Math.hypot(e.clientX - g.startX, e.clientY - g.startY))
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (g.pinchDist > 0) {
        const mid = pointOf((a.x + b.x) / 2, (a.y + b.y) / 2)
        zoomTo(latest.current.shown.scale * (dist / g.pinchDist), mid)
      }
      g.pinchDist = dist
      return
    }
    const { natural: nat, stage: st, shown: cur, zoomed: z } = latest.current
    if (z && nat) {
      setView(
        clampOffset(
          { scale: cur.scale, x: cur.x + e.clientX - prev.x, y: cur.y + e.clientY - prev.y },
          nat,
          st
        )
      )
    } else if (touch && g.moved > TAP_SLOP_PX) {
      setDrag({ x: e.clientX - g.startX, y: e.clientY - g.startY })
    }
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.delete(e.pointerId)
    const g = gesture.current
    if (pointers.current.size > 0) return
    const d = drag
    setDrag(null)
    if (d) {
      if (many && Math.abs(d.x) > SWIPE_PAGE_PX && Math.abs(d.x) > Math.abs(d.y))
        go(d.x < 0 ? 1 : -1)
      else if (d.y > SWIPE_CLOSE_PX && d.y > Math.abs(d.x)) close()
      return
    }
    if (g.moved > TAP_SLOP_PX) return
    // 一次「点」
    if (touch) {
      const now = Date.now()
      if (now - g.lastTap < DOUBLE_TAP_MS) {
        g.lastTap = 0
        toggleZoom(pointOf(e.clientX, e.clientY))
      } else g.lastTap = now
    } else if (!g.onImage) {
      close() // 点空白处
    }
  }

  const copy = (): void => {
    if (viaHost && onCopy) {
      void onCopy(image).then(
        (ok) => flash(setCopyState, ok ? 'copied' : 'failed'),
        () => flash(setCopyState, 'failed')
      )
      return
    }
    if (!url) return
    const png = blobOf(url).then(toPng)
    const write =
      typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write
        ? navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
        : Promise.reject(new Error('clipboard unavailable'))
    void write.then(
      () => flash(setCopyState, 'copied'),
      () => flash(setCopyState, 'failed')
    )
  }

  const save = (): void => {
    if (viaHost && onSave) {
      void onSave(image).catch(() => undefined)
      return
    }
    if (url) void downloadOrShare(url, image.name, touch)
  }

  const dims = natural && natural.width > 0 ? `${natural.width} × ${natural.height}` : ''
  const counter = many ? t('imageViewer.counter', { index: index + 1, total: images.length }) : ''
  const percent = `${Math.round(shown.scale * 100)}%`
  const btn = touch
    ? 'flex h-11 w-11 items-center justify-center rounded-full active:bg-white/15'
    : 'flex h-7 w-7 items-center justify-center rounded-md text-white/85 hover:bg-white/15 hover:text-white'
  const iconSize = touch ? 20 : 16

  return (
    <>
      {touch ? (
        <div
          data-image-viewer-bar=""
          className="flex items-center justify-between px-2 pt-[max(8px,env(safe-area-inset-top))] pb-1"
        >
          <button
            type="button"
            data-image-viewer-action="close"
            aria-label={t('imageViewer.close')}
            className={btn}
            onClick={close}
          >
            <X size={22} />
          </button>
          <span data-image-viewer-counter="" className="text-[14px] text-white/80 tabular-nums">
            {counter}
          </span>
          <button
            type="button"
            data-image-viewer-action="download"
            aria-label={t('imageViewer.share')}
            className={btn}
            onClick={save}
          >
            <Share size={iconSize} />
          </button>
        </div>
      ) : (
        <div
          data-image-viewer-bar=""
          className="flex items-center gap-2 px-3 py-2 text-[12px]"
          style={insetLeft ? { paddingLeft: insetLeft } : undefined}
        >
          <span
            data-image-viewer-name=""
            className="min-w-0 truncate font-medium"
            title={image.name}
          >
            {image.name}
          </span>
          {dims && <span className="shrink-0 text-white/65 tabular-nums">{dims}</span>}
          {counter && (
            <span data-image-viewer-counter="" className="shrink-0 text-white/65 tabular-nums">
              {counter}
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            data-image-viewer-zoom=""
            title={zoomed ? t('imageViewer.fit') : t('imageViewer.actualSize')}
            className="h-7 min-w-[3.25rem] rounded-md px-1.5 text-white/85 tabular-nums hover:bg-white/15"
            onClick={() => toggleZoom()}
          >
            {percent}
          </button>
          <button
            type="button"
            data-image-viewer-action="zoom-out"
            title={t('imageViewer.zoomOut')}
            aria-label={t('imageViewer.zoomOut')}
            className={btn}
            onClick={() => zoomTo(stepScale(shown.scale, -1))}
          >
            <ZoomOut size={iconSize} />
          </button>
          <button
            type="button"
            data-image-viewer-action="zoom-in"
            title={t('imageViewer.zoomIn')}
            aria-label={t('imageViewer.zoomIn')}
            className={btn}
            onClick={() => zoomTo(stepScale(shown.scale, 1))}
          >
            <ZoomIn size={iconSize} />
          </button>
          <button
            type="button"
            data-image-viewer-action="copy"
            data-copy-state={copyState}
            title={
              copyState === 'copied'
                ? t('imageViewer.copied')
                : copyState === 'failed'
                  ? t('imageViewer.copyFailed')
                  : t('imageViewer.copy')
            }
            aria-label={t('imageViewer.copy')}
            className={btn}
            onClick={copy}
          >
            {copyState === 'copied' ? (
              <Check size={iconSize} />
            ) : copyState === 'failed' ? (
              <X size={iconSize} className="text-red-300" />
            ) : (
              <Copy size={iconSize} />
            )}
          </button>
          <button
            type="button"
            data-image-viewer-action="download"
            title={t('imageViewer.download')}
            aria-label={t('imageViewer.download')}
            className={btn}
            onClick={save}
          >
            <Download size={iconSize} />
          </button>
          {onOpenInWindow && image.openPath && (
            <button
              type="button"
              data-image-viewer-action="open"
              title={t('imageViewer.openInWindow')}
              aria-label={t('imageViewer.openInWindow')}
              className={btn}
              onClick={() => {
                onOpenInWindow(image)
                close()
              }}
            >
              <ExternalLink size={iconSize} />
            </button>
          )}
          <button
            type="button"
            data-image-viewer-action="close"
            title={t('imageViewer.close')}
            aria-label={t('imageViewer.close')}
            className={btn}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <div
          ref={stageRef}
          data-image-viewer-stage=""
          data-zoomed={zoomed ? '' : undefined}
          className={`relative min-h-0 flex-1 overflow-hidden touch-none ${
            zoomed ? 'cursor-grab active:cursor-grabbing' : ''
          }`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={(e) => {
            if (!touch && (e.target as HTMLElement).hasAttribute('data-image-viewer-image'))
              toggleZoom(pointOf(e.clientX, e.clientY))
          }}
        >
          {failed ? (
            <div
              data-image-viewer-failed=""
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/70"
            >
              <ImageOff size={28} />
              <span className="text-[13px]">{t('imageViewer.failed')}</span>
            </div>
          ) : url ? (
            <img
              src={url}
              alt={image.name}
              draggable={false}
              data-image-viewer-image=""
              onLoad={(e) => {
                const el = e.currentTarget
                const st = latest.current.stage
                // 没有固有尺寸的 SVG：按舞台的八成算
                setNatural(
                  el.naturalWidth > 0 && el.naturalHeight > 0
                    ? { width: el.naturalWidth, height: el.naturalHeight }
                    : {
                        width: Math.max(1, st.width * 0.8),
                        height: Math.max(1, st.height * 0.8)
                      }
                )
              }}
              onError={() => setFailed(true)}
              style={
                natural
                  ? {
                      width: natural.width * shown.scale,
                      height: natural.height * shown.scale,
                      transform: `translate(-50%, -50%) translate(${shown.x + (drag?.x ?? 0)}px, ${
                        shown.y + Math.max(0, drag?.y ?? 0)
                      }px)`,
                      opacity: drag && drag.y > 0 ? Math.max(0.4, 1 - drag.y / 400) : 1
                    }
                  : { visibility: 'hidden', transform: 'translate(-50%, -50%)' }
              }
              className="absolute left-1/2 top-1/2 max-w-none"
            />
          ) : null}
        </div>

        {!touch && many && (
          <>
            <button
              type="button"
              data-image-viewer-nav="prev"
              aria-label={t('imageViewer.previous')}
              title={t('imageViewer.previous')}
              className="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/85 hover:bg-black/60 hover:text-white"
              onClick={() => go(-1)}
            >
              <ChevronLeft size={22} />
            </button>
            <button
              type="button"
              data-image-viewer-nav="next"
              aria-label={t('imageViewer.next')}
              title={t('imageViewer.next')}
              className="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/85 hover:bg-black/60 hover:text-white"
              onClick={() => go(1)}
            >
              <ChevronRight size={22} />
            </button>
          </>
        )}
      </div>

      {!touch && many && (
        <div
          data-image-viewer-strip=""
          className="flex justify-center gap-1.5 overflow-x-auto px-3 pt-1 pb-3"
        >
          {images.map((img, i) => (
            <StripThumb key={i} image={img} index={i} current={i === index} />
          ))}
        </div>
      )}
      {touch && <div className="pb-[env(safe-area-inset-bottom)]" />}
    </>
  )
}

function StripThumb({
  image,
  index,
  current
}: {
  image: ViewerImage
  index: number
  current: boolean
}): React.JSX.Element {
  const url = useViewerUrl(image)
  return (
    <button
      type="button"
      data-image-viewer-thumb={index}
      aria-current={current ? 'true' : undefined}
      title={image.name}
      onClick={() => useImageViewerStore.getState().go(index)}
      className={`h-10 w-14 shrink-0 overflow-hidden rounded-md bg-white/10 ${
        current ? 'outline outline-2 outline-white' : 'opacity-60 hover:opacity-100'
      }`}
    >
      {url && <img src={url} alt="" draggable={false} className="h-full w-full object-cover" />}
    </button>
  )
}

function flash(set: (s: CopyState) => void, state: CopyState): void {
  set(state)
  setTimeout(() => set('idle'), 1500)
}

async function blobOf(url: string): Promise<Blob> {
  // data: 自己解（页面的 CSP 不一定放 fetch data:）
  const data = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url)
  if (data) {
    const [, mime, b64, body] = data
    const text = b64 ? atob(body) : decodeURIComponent(body)
    const bytes = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
    return new Blob([bytes], { type: mime || 'application/octet-stream' })
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.blob()
}

/** 任意图 → PNG（剪贴板只认 PNG）；经 object URL 进 <img> 再画，SVG 也行，画布不会被污染 */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const objectUrl = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = objectUrl
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth || 1024
    canvas.height = img.naturalHeight || 768
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
    )
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

/** 下载（手机上能分享文件就走系统分享）；取不到字节就退回直接用地址下载 */
async function downloadOrShare(url: string, name: string, preferShare: boolean): Promise<void> {
  let blob: Blob
  try {
    blob = await blobOf(url)
  } catch {
    clickDownload(url, name)
    return
  }
  if (preferShare && typeof navigator.share === 'function' && typeof File !== 'undefined') {
    const file = new File([blob], name, { type: blob.type })
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] })
        return
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
      }
    }
  }
  const objectUrl = URL.createObjectURL(blob)
  clickDownload(objectUrl, name)
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
}

function clickDownload(href: string, name: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
