/**
 * 会话的图标 —— 侧栏的会话行与收件箱的行共用这一个（2026-11-11 用户：两处的状态图标必须是同一套，不各画各的）。
 *
 * 形状说「这是哪种会话」：普通会话一片对话框，有子会话的两片，bot / 定时运行 / 笔记本 / 悬浮各有各的；
 * 颜色和动效说「它在不在跑、跑的是什么」（S1）：
 * - agent 在干活（`run = 'agent'`）：蓝色、实心、呼吸；
 * - 只剩后台命令开着（`run = 'resident'`）：绿色、实心、不动；
 * - 停着：选中时蓝色实心，否则灰色线框（悬浮会话的图标一直是蓝的，那是「它被拎出去了」的意思）。
 * 「实心」只对两种对话框有意义 —— 别的图标填满就看不出形状，只换颜色。
 */
import {
  Bot,
  createLucideIcon,
  FileText,
  MessageSquare,
  MessagesSquare,
  PictureInPicture2,
  Timer
} from 'lucide-react'
import type { SessionRunKind } from '@shuvix/chat-ui'

/**
 * MessagesSquare 的实心版（有子会话的会话，选中 / 在跑时用，与普通会话的实心 MessageSquare 同一层意思）。
 * 不能直接给 MessagesSquare 加 fill：后面那片是条开放路径，填出来是一道斜切口。这里把它沿前片的外轮廓闭合，
 * 两片之间留着和线框版一样的缝。
 */
const MessagesSquareSolid = createLucideIcon('messages-square-solid', [
  [
    'path',
    {
      d: 'M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z',
      key: 'front'
    }
  ],
  [
    'path',
    {
      d: 'M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1h8a4 4 0 0 0 4-4z',
      key: 'back'
    }
  ]
])

/** 会话是哪一种（决定形状）：定时运行 > bot > 笔记本 > 悬浮 > 有子会话 > 普通 */
export type SessionIconShape = 'trigger' | 'bot' | 'notebook' | 'pinned' | 'family' | 'chat'

export function sessionIconShape(flags: {
  isTriggerRun?: boolean
  isBot?: boolean
  isNotebook?: boolean
  isPinned?: boolean
  subCount?: number
}): SessionIconShape {
  if (flags.isTriggerRun) return 'trigger'
  if (flags.isBot) return 'bot'
  if (flags.isNotebook) return 'notebook'
  if (flags.isPinned) return 'pinned'
  return (flags.subCount ?? 0) > 0 ? 'family' : 'chat'
}

export interface SessionIconProps {
  shape: SessionIconShape
  /** 在跑的是哪一种；停着 = null */
  run: SessionRunKind | null
  /** 选中的会话（停着时也是蓝色实心） */
  active?: boolean
  /** 尺寸 class（侧栏给 `sb-icon`，随密度变） */
  className?: string
  size?: number
  /** 悬停提示（画成 svg 里的 `<title>`） */
  label?: string
}

export function SessionIcon({
  shape,
  run,
  active = false,
  className = '',
  size,
  label
}: SessionIconProps): React.JSX.Element {
  const color =
    run === 'agent'
      ? 'text-accent animate-pulse motion-reduce:animate-none'
      : run === 'resident'
        ? 'text-success'
        : active || shape === 'pinned'
          ? 'text-accent'
          : 'text-text-tertiary'
  const solid = run !== null || active
  const props = {
    size,
    className: `${className} ${color}`.trim(),
    'data-session-icon': shape,
    'data-run': run ?? undefined
  }
  const title = label ? <title>{label}</title> : null
  switch (shape) {
    case 'trigger':
      return <Timer {...props}>{title}</Timer>
    case 'bot':
      return <Bot {...props}>{title}</Bot>
    case 'notebook':
      return <FileText {...props}>{title}</FileText>
    case 'pinned':
      return <PictureInPicture2 {...props}>{title}</PictureInPicture2>
    case 'family':
      return solid ? (
        <MessagesSquareSolid fill="currentColor" {...props}>
          {title}
        </MessagesSquareSolid>
      ) : (
        <MessagesSquare {...props}>{title}</MessagesSquare>
      )
    default:
      return (
        <MessageSquare fill={solid ? 'currentColor' : 'none'} {...props}>
          {title}
        </MessageSquare>
      )
  }
}
