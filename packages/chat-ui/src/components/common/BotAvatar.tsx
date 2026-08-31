import { botColorFor, botInitial } from '@shuvix/chat-protocol/utils/botIdentity'

export interface BotAvatarProps {
  /** bot 身份键（取色用 —— 同名恒同色，改 displayName 不换色） */
  name: string
  /** 展示名（取首字用） */
  displayName: string
  /** 边长 px，默认 18 */
  size?: number
  className?: string
}

/**
 * bot 头像：displayName 首字 + 按 name 派生的定色色块（UI 形态裁决②）。
 * 卡头、侧栏、创建对话框、设置页共用 —— 视觉身份只有这一个实现。
 * 文字恒用深色：色板全部是两主题下都偏亮的强调色，不随主题翻转。
 */
export function BotAvatar({
  name,
  displayName,
  size = 18,
  className = ''
}: BotAvatarProps): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-[5px] font-bold select-none flex-shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.55),
        backgroundColor: botColorFor(name),
        color: '#0d1117'
      }}
      aria-hidden
    >
      {botInitial(displayName)}
    </span>
  )
}
