/**
 * HexView —— FilePreview 中 kind='hex' 的渲染器
 *
 * 结构（从上到下）：
 *   magic 徽章（可选）
 *   列头（Offset | 00..0F | ASCII）
 *   虚拟化行容器（只渲染可见 ± OVERSCAN 行）
 *   截断脚注（可选）
 *   DataInspector（底部解读条）
 *
 * 大文件不卡的关键：
 *   - 数据已被主进程 1 MiB 截断
 *   - 通过 startRow..endRow 切片 + 绝对定位，DOM 节点恒定在 ~50 行量级
 *   - HexRow 用 React.memo，滚动时只新渲染进入窗口的行
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HexRow, HEX_ROW_HEIGHT } from './HexRow'
import { HexDataInspector } from './HexDataInspector'

/** 滚动方向上多渲染的行数，避免快速滚动出现空白 */
const OVERSCAN = 8

interface HexViewProps {
  data: Uint8Array
  size: number
  bytesShown: number
  truncated: boolean
  magic?: string
  ext: string
}

export function HexView({
  data,
  size,
  bytesShown,
  truncated,
  magic
}: HexViewProps): React.JSX.Element {
  const { t } = useTranslation()
  const [selectedOffset, setSelectedOffset] = useState<number | null>(null)
  const [endian, setEndian] = useState<'LE' | 'BE'>('LE')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 跟踪滚动容器高度（右栏可拖拽宽度，间接影响高度）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight))
    ro.observe(el)
    setViewportH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const rowCount = Math.ceil(data.length / 16)
  const startRow = Math.max(0, Math.floor(scrollTop / HEX_ROW_HEIGHT) - OVERSCAN)
  const endRow = Math.min(rowCount, Math.ceil((scrollTop + viewportH) / HEX_ROW_HEIGHT) + OVERSCAN)

  return (
    <div className="flex flex-col h-full">
      {/* magic 徽章 */}
      {magic && (
        <div className="flex-shrink-0 px-2 h-5 flex items-center text-[10px] uppercase tracking-wider text-text-tertiary border-b border-border-secondary/30">
          <span className="text-accent/80 truncate" title={magic}>
            {magic}
          </span>
          <span className="ml-auto text-text-tertiary/60 tabular-nums">{formatBytes(size)}</span>
        </div>
      )}

      {/* 列头 —— 与 HexRow 的 column 几何完全一致 */}
      <div className="flex-shrink-0 flex items-center h-[20px] text-[10px] leading-[20px] uppercase tracking-wider text-text-tertiary border-b border-border-secondary/30 bg-bg-secondary font-mono">
        <span className="w-[72px] px-2 select-none">{t('panel.preview.hexOffsetLabel')}</span>
        <div className="flex items-center gap-[1px]">
          {Array.from({ length: 16 }, (_, i) => (
            <span
              key={i}
              className={`w-[18px] text-center tabular-nums ${i === 7 ? 'mr-[6px]' : ''}`}
            >
              {i.toString(16).padStart(2, '0')}
            </span>
          ))}
        </div>
        <span className="ml-3 pl-2 border-l border-border-secondary/30 select-none">
          {t('panel.preview.hexAsciiLabel')}
        </span>
      </div>

      {/* 虚拟化滚动区 */}
      <div
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="flex-1 min-h-0 overflow-auto font-mono"
      >
        <div style={{ height: rowCount * HEX_ROW_HEIGHT, position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              top: startRow * HEX_ROW_HEIGHT,
              left: 0,
              right: 0
            }}
          >
            {Array.from({ length: Math.max(0, endRow - startRow) }, (_, i) => (
              <HexRow
                key={startRow + i}
                row={startRow + i}
                data={data}
                selectedOffset={selectedOffset}
                onSelect={setSelectedOffset}
              />
            ))}
          </div>
        </div>

        {truncated && (
          <div className="px-2 py-2 text-[10px] text-text-tertiary/70 italic border-t border-border-secondary/30">
            {t('panel.preview.hexTruncated', {
              shown: formatBytes(bytesShown),
              total: formatBytes(size)
            })}
          </div>
        )}
      </div>

      {/* DataInspector 底部解读条 */}
      <HexDataInspector
        data={data}
        offset={selectedOffset}
        endian={endian}
        onEndianChange={setEndian}
      />
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}
