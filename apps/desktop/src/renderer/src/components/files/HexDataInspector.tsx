/**
 * Hex Data Inspector —— 底部约 80px 高的解读条
 * 选中某个字节后，把该偏移处当作多种基元类型解读（i8/u8/.../f64/ascii/utf-8）
 * 顶部右上提供 LE/BE 切换；越界类型显示 '—'
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

type Endian = 'LE' | 'BE'

interface HexDataInspectorProps {
  data: Uint8Array
  /** 全局字节偏移；null = 未选中 */
  offset: number | null
  endian: Endian
  onEndianChange: (e: Endian) => void
}

export function HexDataInspector({
  data,
  offset,
  endian,
  onEndianChange
}: HexDataInspectorProps): React.JSX.Element {
  const { t } = useTranslation()

  const rows = useMemo(() => {
    if (offset == null) return []
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const le = endian === 'LE'
    const safe = <T,>(fn: () => T): string => {
      try {
        const v = fn()
        return typeof v === 'bigint' ? v.toLocaleString('en-US') : String(v)
      } catch {
        return '—'
      }
    }
    return [
      ['i8', safe(() => dv.getInt8(offset))],
      ['u8', safe(() => dv.getUint8(offset))],
      ['i16', safe(() => dv.getInt16(offset, le))],
      ['u16', safe(() => dv.getUint16(offset, le))],
      ['i32', safe(() => dv.getInt32(offset, le).toLocaleString('en-US'))],
      ['u32', safe(() => dv.getUint32(offset, le).toLocaleString('en-US'))],
      ['i64', safe(() => dv.getBigInt64(offset, le))],
      ['u64', safe(() => dv.getBigUint64(offset, le))],
      ['f32', safe(() => dv.getFloat32(offset, le).toPrecision(7))],
      ['f64', safe(() => dv.getFloat64(offset, le).toPrecision(15))],
      ['ascii', asciiAt(data, offset)],
      ['utf-8', utf8At(data, offset)]
    ] as Array<[string, string]>
  }, [data, offset, endian])

  return (
    <div className="flex-shrink-0 border-t border-border-secondary/30 bg-bg-primary/30">
      {/* 顶栏：左 offset 标签 + 右 LE/BE 切换 */}
      <div className="flex items-center justify-between px-2 h-5 text-[10px] text-text-tertiary">
        <span className="uppercase tracking-wider">
          {offset == null
            ? t('panel.preview.hexInspectorEmpty')
            : `Offset ${offset.toString(16).padStart(8, '0')}`}
        </span>
        <div className="flex items-center gap-px font-mono">
          {(['LE', 'BE'] as const).map((e) => (
            <button
              key={e}
              onClick={() => onEndianChange(e)}
              className={[
                'px-1.5 rounded-[2px] tabular-nums',
                endian === e
                  ? 'bg-accent/25 text-text-primary'
                  : 'text-text-tertiary hover:text-text-secondary'
              ].join(' ')}
            >
              {e}
            </button>
          ))}
        </div>
      </div>

      {/* 2 列 grid：6 行 × 2 字段 = 12 条 */}
      {offset != null && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-px px-2 pb-1.5 font-mono text-[10px]">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-2">
              <span className="text-text-tertiary w-10 shrink-0">{label}</span>
              <span className="text-text-secondary truncate" title={value}>
                {value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 取 offset 处单字节 ASCII；不可打印用 '·' 占位 */
function asciiAt(data: Uint8Array, offset: number): string {
  if (offset < 0 || offset >= data.length) return '—'
  const byte = data[offset]
  if (byte >= 0x20 && byte <= 0x7e)
    return `${String.fromCharCode(byte)} (0x${byte.toString(16).padStart(2, '0')})`
  return `· (0x${byte.toString(16).padStart(2, '0')})`
}

/** 从 offset 起最多 4 字节按 UTF-8 解码出一个 codepoint；失败返回 '—' */
function utf8At(data: Uint8Array, offset: number): string {
  if (offset < 0 || offset >= data.length) return '—'
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    // UTF-8 最多 4 字节，先按可读区间裁剪避免越界
    const slice = data.subarray(offset, Math.min(offset + 4, data.length))
    const text = decoder.decode(slice)
    const cp = text.codePointAt(0)
    if (cp == null) return '—'
    const ch = String.fromCodePoint(cp)
    return `${ch} (U+${cp.toString(16).toUpperCase().padStart(4, '0')})`
  } catch {
    return '—'
  }
}
