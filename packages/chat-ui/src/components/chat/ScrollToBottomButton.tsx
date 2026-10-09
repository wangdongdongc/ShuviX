import { ArrowDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** 运行指示三点的错峰（ms）：一道波从左扫到右 */
const DOT_DELAYS = [0, 160, 320]

/**
 * 「回到底部」按钮 —— 悬在输入卡片正上方居中的一枚小圆钮，列表离底部够远时才淡入。
 *
 * 本会话正在跑时它兼作运行指示：平时是三个依次起伏的强调色圆点 + 强调色描边（「下面还在写」），
 * 悬停或键盘聚焦才换回箭头（「点这里回去」）。没在跑就始终是箭头。
 *
 * 不显示时仍在 DOM 里（淡出动画要它），但不接指针、不进 Tab 序、对读屏隐藏；圆点只在显示时才挂，
 * 免得看不见的无限动画一直占着合成。
 * 刻意**不设 z-index** 且在 DOM 里排在输入卡片之前：输入卡片向上展开的浮层（模型选择、斜杠命令、@ 提及）
 * 要盖在它上面，而不是被它盖住；列表是 z-0、排在它之前，所以它仍画在正文之上。
 */
export function ScrollToBottomButton({
  visible,
  running,
  onClick
}: {
  visible: boolean
  /** 本会话正在运行（一轮还没收尾） */
  running: boolean
  onClick: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const showDots = visible && running
  return (
    <button
      type="button"
      data-scroll-to-bottom=""
      data-running={showDots ? '' : undefined}
      aria-label={t('chat.scrollToBottom')}
      title={t('chat.scrollToBottom')}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      onClick={onClick}
      // 底边 = 输入卡片外框高度（含 p-2 的 8px 外边距）+ 4px：与卡片描边之间留 12px
      style={{ bottom: 'calc(var(--chat-input-h, 0px) + 4px)' }}
      // 外观取输入卡片同款（半透明底 + 磨砂 + 淡描边 + shadow-md），读起来是那张卡片的附属件
      className={`group absolute left-1/2 -translate-x-1/2 flex items-center justify-center w-7 h-7 rounded-full border bg-bg-primary/80 backdrop-blur-md shadow-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-[opacity,translate,border-color] duration-150 ${
        showDots ? 'border-accent/45' : 'border-border-secondary/60'
      } ${visible ? 'opacity-100' : 'opacity-0 translate-y-1 pointer-events-none'}`}
    >
      {showDots && (
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center gap-[3px] transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
        >
          {DOT_DELAYS.map((delay) => (
            <span
              key={delay}
              className="w-1 h-1 rounded-full bg-accent animate-[scroll-dot-wave_1.2s_ease-in-out_infinite] motion-reduce:animate-none"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
      )}
      <ArrowDown
        size={14}
        className={
          showDots
            ? 'opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100'
            : undefined
        }
      />
    </button>
  )
}
