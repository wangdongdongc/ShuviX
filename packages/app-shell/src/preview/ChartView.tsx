import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  FileImage,
  Loader2,
  Maximize,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { renderMermaid, type MermaidResult } from '@shuvix/atomic-editor'
import { getHostApi } from '@shuvix/chat-ui'
import {
  CHART_PNG_SCALE,
  blobToBase64,
  canCopyImage,
  chartExportName,
  chartExportPath,
  copyImageToClipboard,
  downloadBlob,
  normalizeChartSvg,
  rasterizeChartSvg,
  svgBlob
} from './chartExport'

/**
 * ChartView — 图表契约文件（shuvix:chart）的专用渲染视口。
 *
 * 绕过 markdown 编辑器直接 mermaid.render（懒加载与 SVG 缓存与 atomic-editor 共享），
 * 图表落在卡片上，由视口统一控制变换：
 *   - 初始「适应宽度」：图表宽度贴满面板（允许放大 —— mermaid 自带的 max-width 只缩不放，
 *     正是「不填充空间」的根因，注入后即刻移除）；高图从顶部对齐，向下平移阅读；
 *   - 自动适配不留外边距，四周留白只由卡片内边距 CARD_PAD 提供；卡片横向铺满视口时
 *     去掉描边/圆角/投影（贴边的 chrome 只会在边缘留豁口），缩小到视口内时恢复卡片观感；
 *   - 触摸板捏合 / Ctrl(⌘)+滚轮 = 缩放（光标为锚，捏合在 Chromium 中即 ctrlKey wheel）；
 *     普通滚轮 / 双指滚动 = 平移；拖拽平移；双击 = 适应窗口（整图可见）；
 *   - 平移轴向约束（阅读器惯例）：某轴内容不超视口 → 该轴锁定（横向居中/纵向贴顶），
 *     适应宽度下双指滑动只会上下走、不会把图拖偏；超视口的轴钳制在边界内；
 *   - 右下工具栏：缩小 / 百分比（点击回初始的「适应宽度」）/ 放大 / 适应窗口 ——
 *     工具栏拦截 pointerdown，避免容器的拖拽指针捕获吞掉按钮 click；
 *   - 视图模式跟踪：适应宽度 / 适应窗口两种自动模式在容器尺寸变化时按当前模式重排
 *     （面板拖宽即时受益）；缩放/平移进入手动模式后不再自动打扰；
 *   - 主题跟随宿主明暗：按容器实际背景亮度选 mermaid 'dark'/'default' 主题与卡片底色，
 *     data-theme 切换时重渲染（两主题 SVG 各自缓存，回切零开销）。
 *
 * 容器常驻挂载（加载/错误态渲染在其内），wheel 原生监听在挂载时一次绑定。
 * mermaid 语法错误显示错误卡片（含原始代码）；顶栏「查看源码」由 FilePreview 提供。
 */

/**
 * 卡片内边距（参与自然尺寸与适配计算）—— 图表描边与卡片边缘之间的唯一留白。
 * 适配不再额外留边（见 applyFit）：卡片贴满视口，这里是铺满时四周仅剩的余量。
 */
const CARD_PAD = 12
const SCALE_MIN = 0.1
const SCALE_MAX = 8

interface ViewTransform {
  scale: number
  tx: number
  ty: number
}

/**
 * 视图模式：fitWidth（初始/百分比按钮）与 fitContain（适应窗口/双击）是「自动模式」——
 * 容器尺寸变化时按当前模式重排；缩放/平移/拖拽落入 manual 后不再自动调整。
 */
type ViewMode = 'fitWidth' | 'fitContain' | 'manual'

const clampScale = (s: number): number => Math.max(SCALE_MIN, Math.min(SCALE_MAX, s))

/** 导出菜单条目：图标 + 文案，进行中转圈、刚完成打勾 */
function ExportItem({
  icon,
  label,
  busy,
  done,
  onClick
}: {
  icon: React.ReactNode
  label: string
  busy: boolean
  done: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover/50 disabled:opacity-50 transition-colors"
    >
      <span className="flex-shrink-0 text-text-tertiary">
        {done ? <Check size={13} className="text-accent" /> : icon}
      </span>
      <span className="truncate">{label}</span>
      {busy && <Loader2 size={12} className="ml-auto flex-shrink-0 animate-spin" />}
    </button>
  )
}

/** 元素实际背景是否为暗色（相对亮度 < 50%）—— 主题 id 无关，宿主/自定义主题通吃 */
function surfaceIsDark(el: HTMLElement | null): boolean {
  if (!el) return false
  try {
    const m = getComputedStyle(el).backgroundColor.match(/\d+(\.\d+)?/g)
    if (!m || m.length < 3) return false
    // 透明背景（alpha 0）判不出来，保守按亮色处理
    if (m.length >= 4 && parseFloat(m[3]) === 0) return false
    const [r, g, b] = m.slice(0, 3).map(Number)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
  } catch {
    return false
  }
}

/** 导出动作；copy = PNG 进剪贴板 */
type ExportKind = 'png' | 'svg' | 'copy'

export function ChartView({
  source,
  path
}: {
  source: string
  /** 图表文件绝对路径 —— 导出时用来推导同名同目录的默认落点；缺省则退化为 chart.png */
  path?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [result, setResult] = useState<MermaidResult | null>(null)
  /** 卡片自然尺寸（svg 视图框 + 内边距）；null = 尚未量取，卡片先隐藏避免错误缩放闪帧 */
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [view, setView] = useState<ViewTransform>({ scale: 1, tx: 0, ty: 0 })
  /** 宿主明暗（据容器实际背景亮度）：决定 mermaid 主题与卡片底色 */
  const [isDark, setIsDark] = useState(false)
  /** 容器可视宽度（ResizeObserver 维护）—— 仅用于判定卡片是否已横向铺满视口 */
  const [viewportW, setViewportW] = useState(0)
  /** 导出菜单：展开态 / 进行中的动作 / 刚完成的动作（打勾 1.6s）/ 失败原因 */
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState<ExportKind | null>(null)
  const [exported, setExported] = useState<ExportKind | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const exportMenuRef = useRef<HTMLDivElement | null>(null)
  /** 当前视图模式（初始 = 适应宽度）；容器 resize / 主题重渲染按自动模式重排，manual 不打扰 */
  const viewModeRef = useRef<ViewMode>('fitWidth')
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  // 明暗探测：容器常驻，首帧（passive effect 之前）即可量到正确背景；主题切换时重算
  useLayoutEffect(() => {
    const compute = (): void => setIsDark(surfaceIsDark(containerRef.current))
    compute()
    const mo = new MutationObserver(compute)
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class']
    })
    return () => mo.disconnect()
  }, [])

  // 渲染（缓存命中即同步返回）。主题以效应执行时刻的 DOM 实测为准（首帧即正确，
  // 不用等 isDark 状态落定）；isDark 变化时重跑以切换主题渲染。
  // 源码变化（文件被智能体修订）重置视图；主题切换保留用户的缩放/平移。
  const lastSourceRef = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const sourceChanged = lastSourceRef.current !== source
    lastSourceRef.current = source
    if (sourceChanged) {
      setResult(null)
      setNatural(null)
      viewModeRef.current = 'fitWidth'
    }
    const theme = surfaceIsDark(containerRef.current) ? 'dark' : 'default'
    void renderMermaid(source, { theme }).then((r) => {
      if (!cancelled) setResult(r)
    })
    return () => {
      cancelled = true
    }
  }, [source, isDark])

  // SVG 注入后：移除 mermaid 自带的 max-width（缩放全权归视口），量取自然尺寸
  useEffect(() => {
    if (!result?.svg) return
    const svg = cardRef.current?.querySelector('svg') as SVGSVGElement | null
    if (!svg) return
    svg.style.maxWidth = 'none'
    let w = 0
    let h = 0
    const vb = svg.viewBox?.baseVal
    if (vb && vb.width > 0 && vb.height > 0) {
      w = vb.width
      h = vb.height
    } else {
      try {
        const b = svg.getBBox()
        w = b.width
        h = b.height
      } catch {
        /* 未布局时 getBBox 可能抛错，走兜底 */
      }
    }
    if (w <= 0 || h <= 0) {
      w = svg.clientWidth || 300
      h = svg.clientHeight || 150
    }
    svg.setAttribute('width', String(w))
    svg.setAttribute('height', String(h))
    setNatural({ w: w + CARD_PAD * 2, h: h + CARD_PAD * 2 })
  }, [result])

  /**
   * 应用自动适配模式（都不留外边距 —— 卡片贴满视口，留白只由 CARD_PAD 提供）：
   *   - fitWidth（初始视图）：宽度贴满视口（允许放大）；高图顶部对齐向下阅读，矮图垂直居中
   *   - fitContain：宽高双向等比填满，整图可见，居中
   */
  const applyFit = useCallback(
    (mode: 'fitWidth' | 'fitContain') => {
      const el = containerRef.current
      if (!el || !natural) return
      const cw = el.clientWidth
      const ch = el.clientHeight
      if (cw <= 0 || ch <= 0) return
      const widthScale = cw / natural.w
      const scale = clampScale(
        mode === 'fitWidth' ? widthScale : Math.min(widthScale, ch / natural.h)
      )
      viewModeRef.current = mode
      setView({
        scale,
        tx: (cw - natural.w * scale) / 2,
        // 高于视口时顶部对齐（fitWidth 的高图场景），否则垂直居中（fitContain 恒居中）
        ty: Math.max((ch - natural.h * scale) / 2, 0)
      })
    },
    [natural]
  )
  const fitWidth = useCallback(() => applyFit('fitWidth'), [applyFit])
  const fitContain = useCallback(() => applyFit('fitContain'), [applyFit])

  /**
   * 平移约束：某轴内容不超视口 → 锁定该轴（居中，与 applyFit 同款规则），
   * 超视口 → 平移钳制在视口边界内（不允许拖出空白）。缩放/滚动/拖拽统一经此收口，
   * 适应宽度阅读时横向拖不偏、纵向滚不过头。
   */
  const clampView = useCallback(
    (v: ViewTransform): ViewTransform => {
      const el = containerRef.current
      if (!el || !natural) return v
      const cw = el.clientWidth
      const ch = el.clientHeight
      if (cw <= 0 || ch <= 0) return v
      const w = natural.w * v.scale
      const h = natural.h * v.scale
      const tx = w <= cw ? (cw - w) / 2 : Math.min(0, Math.max(cw - w, v.tx))
      const ty = h <= ch ? (ch - h) / 2 : Math.min(0, Math.max(ch - h, v.ty))
      return tx === v.tx && ty === v.ty ? v : { ...v, tx, ty }
    },
    [natural]
  )

  // 自然尺寸就绪 → 按当前自动模式适配（manual 保留视图 —— 覆盖主题切换重渲染的场景）；
  // 容器尺寸变化且处于自动模式 → 按该模式重排
  useEffect(() => {
    const mode = viewModeRef.current
    if (natural && mode !== 'manual') applyFit(mode)
  }, [natural, applyFit])
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // observe 会立即回调一次，viewportW 初值由此落定，无需在效应体里额外量取
    const ro = new ResizeObserver(() => {
      setViewportW(el.clientWidth)
      const mode = viewModeRef.current
      if (mode !== 'manual') applyFit(mode)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [applyFit])

  /** 以容器坐标 (cx, cy) 为锚缩放（结果过平移约束） */
  const zoomAt = useCallback(
    (cx: number, cy: number, factor: number) => {
      viewModeRef.current = 'manual'
      setView((v) => {
        const scale = clampScale(v.scale * factor)
        const k = scale / v.scale
        return clampView({ scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k })
      })
    },
    [clampView]
  )

  /** 以容器中心为锚缩放（工具栏按钮用） */
  const zoomCenter = useCallback(
    (factor: number) => {
      const el = containerRef.current
      if (!el) return
      zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor)
    },
    [zoomAt]
  )

  // 滚轮/触摸板：捏合与 Ctrl(⌘)+滚轮 = 缩放（Chromium 把触摸板捏合上报为 ctrlKey wheel），
  // 普通滚轮/双指滚动 = 平移。须 preventDefault（React 合成 wheel 是 passive），原生监听接管；
  // 容器常驻挂载 → 本效应在挂载时即绑定成功
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        // 指数映射平滑捏合小增量；单步限幅防 Ctrl+鼠标滚轮一格跳变过大
        const factor = Math.max(1 / 1.25, Math.min(1.25, Math.exp(-e.deltaY * 0.01)))
        const rect = el.getBoundingClientRect()
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor)
      } else {
        viewModeRef.current = 'manual'
        setView((v) => clampView({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt, clampView])

  // 导出菜单：点击别处 / Esc 关闭。用捕获期原生监听 —— 工具栏自己会 stopPropagation
  // 阻断冒泡（防容器吞掉按钮 click），冒泡期的文档监听收不到
  useEffect(() => {
    if (!exportOpen) return
    const onDown = (e: PointerEvent): void => {
      if (!exportMenuRef.current?.contains(e.target as Node)) setExportOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExportOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [exportOpen])

  /** 落盘：宿主有保存能力就弹系统对话框（默认落在图表文件旁边），否则走浏览器原生下载 */
  const saveExport = useCallback(
    async (blob: Blob, ext: 'png' | 'svg'): Promise<boolean> => {
      const host = getHostApi()
      if (!host) {
        downloadBlob(blob, chartExportName(path, ext))
        return true
      }
      const res = await host.files.saveAs({
        defaultPath: chartExportPath(path, ext),
        dataBase64: await blobToBase64(blob)
      })
      if (res.ok) return true
      if ('canceled' in res) return false
      throw new Error(res.error)
    },
    [path]
  )

  const runExport = useCallback(
    async (kind: ExportKind): Promise<void> => {
      const svg = result?.svg
      if (!svg || exporting) return
      setExporting(kind)
      setExportError(null)
      try {
        // 背景取卡片的实际底色（亮色白 / 暗色深）—— mermaid SVG 本身透明，
        // 不烘背景的话暗色主题导出的浅色文字贴到白底文档里等于隐形
        const background = cardRef.current
          ? getComputedStyle(cardRef.current).backgroundColor
          : isDark
            ? '#1e1e1e'
            : '#ffffff'
        const normalized = normalizeChartSvg(svg, background)
        let succeeded: boolean
        if (kind === 'svg') {
          succeeded = await saveExport(svgBlob(normalized.xml), 'svg')
        } else {
          const png = await rasterizeChartSvg(normalized)
          if (kind === 'copy') {
            await copyImageToClipboard(png)
            succeeded = true
          } else {
            succeeded = await saveExport(png, 'png')
          }
        }
        if (succeeded) {
          setExported(kind)
          setTimeout(() => {
            setExported(null)
            setExportOpen(false)
          }, 1600)
        } else {
          setExportOpen(false) // 用户在保存对话框里取消了
        }
      } catch (e) {
        setExportError(e instanceof Error ? e.message : String(e))
      } finally {
        setExporting(null)
      }
    },
    [result, exporting, isDark, saveExport]
  )

  const ready = !!result?.svg && !result.error
  /** 卡片已横向铺满视口（适应宽度的常态）→ 去掉描边/圆角/投影：贴边时这些 chrome 只会在边缘留豁口 */
  const bleeds = !!natural && viewportW > 0 && natural.w * view.scale >= viewportW - 0.5

  return (
    <div
      ref={containerRef}
      className={`relative h-full overflow-hidden bg-bg-secondary select-none ${
        ready ? 'cursor-grab active:cursor-grabbing' : ''
      }`}
      onDoubleClick={ready ? fitContain : undefined}
      onPointerDown={(e) => {
        if (!ready || e.button !== 0) return
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* 合成事件无活动指针时会抛，忽略 */
        }
        const v = view
        dragRef.current = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty }
      }}
      onPointerMove={(e) => {
        const d = dragRef.current
        if (!d) return
        viewModeRef.current = 'manual'
        setView((v) => clampView({ ...v, tx: d.tx + e.clientX - d.x, ty: d.ty + e.clientY - d.y }))
      }}
      onPointerUp={() => {
        dragRef.current = null
      }}
      onPointerCancel={() => {
        dragRef.current = null
      }}
    >
      {result?.error || (result && !result.svg) ? (
        // mermaid 语法错误：错误卡片 + 原始代码（覆盖整面，自己管滚动与光标）
        <div className="absolute inset-0 overflow-auto bg-bg-secondary p-4 cursor-auto select-text">
          <div className="flex items-center gap-1.5 text-xs text-red-400 mb-2">
            <AlertCircle size={13} className="flex-shrink-0" />
            {t('panel.preview.chartError')}
          </div>
          <pre className="text-[11px] leading-relaxed text-text-tertiary whitespace-pre-wrap break-all">
            {result.error ?? 'Unknown error'}
            {'\n\n'}
            {source}
          </pre>
        </div>
      ) : (
        result?.svg && (
          <>
            {/* 图表卡片：亮色主题白底（mermaid default 的可读面），暗色主题深底 + dark 主题渲染 */}
            <div
              ref={cardRef}
              className={`absolute top-0 left-0 ${bleeds ? '' : 'rounded-lg border shadow-sm'} ${
                isDark
                  ? 'bg-bg-primary border-border-secondary/60'
                  : 'bg-white border-border-secondary/40'
              }`}
              style={{
                padding: CARD_PAD,
                width: natural?.w,
                height: natural?.h,
                transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
                transformOrigin: '0 0',
                // 量取前隐藏防错误缩放闪帧；量好后必须「不写」而非显式 'visible' ——
                // 显式 visible 会穿透宿主面板（RightPanel/SessionPanel）visibility:hidden
                // 的常驻挂载切换，把图表叠画到浏览器等其它同栈面板上
                visibility: natural ? undefined : 'hidden'
              }}
              dangerouslySetInnerHTML={{ __html: result.svg }}
            />

            {/* 右下工具栏：缩小 / 百分比(点击回 1:1) / 放大 / 适应窗口。
                拦截 pointerdown / dblclick —— 否则容器把指针捕获走，按钮 click 合成不出来 */}
            <div
              className="absolute bottom-2.5 right-2.5 flex items-center gap-0.5 p-0.5 rounded-lg border border-border-secondary/60 bg-bg-primary/80 backdrop-blur-md shadow-sm cursor-auto"
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => zoomCenter(1 / 1.25)}
                className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
                title={t('panel.preview.chartZoomOut')}
              >
                <ZoomOut size={13} />
              </button>
              <button
                onClick={fitWidth}
                className="px-1 min-w-[38px] text-center text-[10px] tabular-nums text-text-tertiary hover:text-text-secondary transition-colors"
                title={t('panel.preview.chartFitWidth')}
              >
                {Math.round(view.scale * 100)}%
              </button>
              <button
                onClick={() => zoomCenter(1.25)}
                className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
                title={t('panel.preview.chartZoomIn')}
              >
                <ZoomIn size={13} />
              </button>
              <div className="w-px h-3.5 bg-border-secondary/60 mx-0.5" />
              <button
                onClick={fitContain}
                className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
                title={t('panel.preview.chartFit')}
              >
                <Maximize size={13} />
              </button>
              <div className="w-px h-3.5 bg-border-secondary/60 mx-0.5" />
              {/* 导出：点开后选格式。菜单向上弹（工具栏贴在视口底部） */}
              <div className="relative" ref={exportMenuRef}>
                <button
                  onClick={() => setExportOpen((v) => !v)}
                  className={[
                    'p-1 rounded-md transition-colors',
                    exportOpen
                      ? 'text-accent bg-bg-hover/50'
                      : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50'
                  ].join(' ')}
                  title={t('panel.preview.chartExport')}
                >
                  <Download size={13} />
                </button>
                {exportOpen && (
                  <div className="absolute bottom-full right-0 mb-1.5 min-w-[190px] p-1 rounded-lg border border-border-secondary/60 bg-bg-primary/95 backdrop-blur-md shadow-lg">
                    <ExportItem
                      icon={<FileImage size={13} />}
                      label={t('panel.preview.chartExportPng', { scale: CHART_PNG_SCALE })}
                      busy={exporting === 'png'}
                      done={exported === 'png'}
                      onClick={() => void runExport('png')}
                    />
                    <ExportItem
                      icon={<Download size={13} />}
                      label={t('panel.preview.chartExportSvg')}
                      busy={exporting === 'svg'}
                      done={exported === 'svg'}
                      onClick={() => void runExport('svg')}
                    />
                    {canCopyImage() && (
                      <ExportItem
                        icon={<Copy size={13} />}
                        label={
                          exported === 'copy'
                            ? t('panel.preview.chartCopied')
                            : t('panel.preview.chartCopyImage')
                        }
                        busy={exporting === 'copy'}
                        done={exported === 'copy'}
                        onClick={() => void runExport('copy')}
                      />
                    )}
                    {exportError && (
                      <div className="px-2 py-1 text-[10px] leading-snug text-red-400 break-all">
                        {t('panel.preview.chartExportFailed')}: {exportError}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )
      )}
    </div>
  )
}
