/**
 * 询问与审批卡片共用的选项行 —— 两张卡都是「一个问题 + 一列可点的行」（Claude Code 的权限提示是参照）。
 *
 * 一行占满卡片宽度、上面一条细线，行首是序号（勾选题勾上后换成对勾）；桌面紧凑档约 32px 高，手机触屏档
 * 44px、正文 16px —— 手指点得中，也不用再把三颗小按钮挤进一行。多出来的选择（记住这个文件 / 所在文件夹）
 * 就是多一行，所以不再有分体按钮与下拉。
 *
 * 桌面上数字键 1–9 直接选对应的行（`useOptionHotkeys`），但只在焦点不在任何可编辑元素里时：输入框里
 * 打的「1」是要发给 AI 的字，审批卡片绝不能被一次按键顺手放行。
 */
import { Check } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useChatDensity } from '../../../host/chatHostContext'

export interface OptionRowProps {
  /** 0 起；序号显示为 index + 1 */
  index: number
  label: string
  /** 第二行：选项说明 / 记住的文件夹路径 */
  detail?: string
  /** 第二行是路径：等宽、从左端截断（路径的尾巴才是认得出的部分） */
  detailIsPath?: boolean
  /** 主选项（允许这一次）：正文加粗 */
  primary?: boolean
  /** 勾选题：true / false 显示勾选态；undefined = 不可勾选（点了就提交） */
  checked?: boolean
  onPick: () => void
  /** 挂在按钮上的 data-* 属性（测试与页面对象的锚点） */
  data?: Record<string, string>
}

export function OptionRow({
  index,
  label,
  detail,
  detailIsPath,
  primary,
  checked,
  onPick,
  data
}: OptionRowProps): React.JSX.Element {
  const touch = useChatDensity() === 'touch'
  const selected = checked === true
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={checked === undefined ? undefined : selected}
      className={`w-full flex items-center text-left border-t border-border-secondary/40 transition-colors ${
        touch ? 'min-h-11 gap-3 px-4 py-2 text-sm' : 'min-h-8 gap-2.5 px-3.5 py-1.5 text-[13px]'
      } ${selected ? 'bg-accent/10' : 'hover:bg-bg-hover/60 active:bg-bg-hover'}`}
      {...data}
    >
      <span
        aria-hidden="true"
        className={`flex-shrink-0 flex items-center justify-center rounded-[5px] border tabular-nums ${
          touch ? 'w-5 h-5 text-[11px]' : 'w-4 h-4 text-[10px]'
        } ${
          selected
            ? 'bg-accent border-accent text-white'
            : 'border-border-primary/70 text-text-secondary'
        }`}
      >
        {selected ? <Check size={touch ? 13 : 11} /> : index + 1}
      </span>
      <span className="flex-1 min-w-0">
        <span
          className={`block leading-snug break-words ${
            primary || selected ? 'font-medium text-text-primary' : 'text-text-primary'
          }`}
          data-option-label=""
        >
          {label}
        </span>
        {detail &&
          (detailIsPath ? (
            <span
              className={`block truncate font-mono text-text-tertiary [direction:rtl] text-left ${
                touch ? 'text-[12px]' : 'text-[11px]'
              }`}
              data-option-detail=""
            >
              <bdi>{detail}</bdi>
            </span>
          ) : (
            <span
              className={`block leading-snug break-words text-text-tertiary ${
                touch ? 'text-[13px]' : 'text-[11.5px]'
              }`}
              data-option-detail=""
            >
              {detail}
            </span>
          ))}
      </span>
    </button>
  )
}

/**
 * 焦点在可编辑元素里（输入框、笔记本编辑器）时数字键是打字，不是选项。目标取事件路径的第一个节点：
 * shadow root 里的输入框在 document 上的监听看来只是它的宿主
 */
function isEditableTarget(e: KeyboardEvent): boolean {
  const target = e.composedPath()[0] ?? e.target
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (
    target.isContentEditable ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  )
}

/**
 * 数字键选行（只在桌面紧凑档）：按 1–9 等于点第 n 行。焦点在可编辑元素里、带修饰键、输入法组字中、
 * 长按连发都不算。`onPick` 每次渲染都可能是新函数，用 ref 读最新的，监听只随行数与开关重装。
 */
export function useOptionHotkeys(count: number, onPick: (index: number) => void): void {
  const touch = useChatDensity() === 'touch'
  const pickRef = useRef(onPick)
  useEffect(() => {
    pickRef.current = onPick
  })
  useEffect(() => {
    if (touch || count === 0) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.repeat || e.isComposing) return
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (isEditableTarget(e)) return
      if (!/^[1-9]$/.test(e.key)) return
      const index = Number(e.key) - 1
      if (index >= count) return
      e.preventDefault()
      pickRef.current(index)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [count, touch])
}
