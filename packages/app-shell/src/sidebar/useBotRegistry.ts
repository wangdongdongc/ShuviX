/**
 * bot 注册表（`~/.shuvix/bots/`）在侧栏里的那一份 —— 「Bots」分节的骨架：一个生效的 bot 一组，它的会话填进去
 * （与项目组「项目骨架 + 会话填入」同一个形状，见 ProjectSessionGroups）。
 *
 * 扫描是**一挂上就扫**（分节常驻侧栏，组头要立刻有名字），之后窗口聚焦 + `bot.changed`（笔记本写入 / 新建 / 删除 /
 * 归档 / 恢复）重扫，递增序号丢弃过期回包。bot 自己在答话途中用 `edit` 改 md 不广播，由聚焦重扫兜底。
 *
 * prop 驱动、不触宿主 API：清单与各项动作由宿主经 `BotGroupAdapter` 注入（桌面 window.api.bot 的窄投影；扩展没有
 * bot，不注入则整节不画）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppEvent } from '@shuvix/chat-ui'

/** 一个合法 bot（侧栏组头与位置选择用到的最小字段） */
export interface BotGroupItem {
  name: string
  displayName: string
  description: string
  /** bots 目录下的文件名 —— 笔记本会话按它认（名字随编辑在变，文件名不变） */
  fileName: string
}

/** 同名的另一份压过了它、当前不生效的 bot 文件 */
export interface BotGroupShadowedItem extends BotGroupItem {
  /** 压过它的那份文件的文件名 */
  shadowedBy: string
}

/** 目录里无法解析的文件（身份是文件名 —— 它解析不出 name） */
export interface BotGroupInvalidFile {
  fileName: string
  /** 解析器的人读拒绝理由（行的 title 提示） */
  error: string
}

/** 新会话的工作位置：一个项目（引用，不是成员），或临时工作区 */
export type BotSessionLocation = { workProject: string } | { temp: true }

/** 宿主注入的 bots 能力（桌面：window.api.bot 的窄投影） */
export interface BotGroupAdapter {
  /** 拉取注册表：生效的 bot + 被同名遮蔽的 + 无法解析的文件（须为稳定引用，避免重复扫描） */
  list: () => Promise<{
    bots: BotGroupItem[]
    shadowed: BotGroupShadowedItem[]
    invalid: BotGroupInvalidFile[]
    /** 归档了的 bot 名：它们的会话一起藏起来（与归档项目一样），不当成「找不到文件」；缺省没有 */
    archived?: string[]
  }>
  /** 打开 / 复用这份文件的笔记本会话（宿主负责建会话、刷新列表并选中）；title 只在新建会话时用 */
  open: (fileName: string, title?: string) => void | Promise<void>
  /** 按模板新建一份 bot 文件并打开它的笔记本 */
  create: () => void | Promise<void>
  /** 打开 bots 目录（OS 文件管理器） */
  openFolder: () => void | Promise<unknown>
  /**
   * 和该 bot 在选定的位置新建一条会话（宿主负责建会话、刷新列表并选中）。位置必须先选（用户 2026-10-30：
   * 不给缺省），由「Bots」分节的位置选择交进来
   */
  newSession: (name: string, location: BotSessionLocation) => void | Promise<void>
  /**
   * 归档 bot（与项目一样：侧栏里只归档，删除在 设置 → 已归档 里、连同它的会话）。归档后经 `bot.changed` 重扫，
   * 这一组与它的会话一起藏起来
   */
  archive: (bot: BotGroupItem) => void
  /** 删除无法解析 / 被同名遮蔽的那份文件（宿主自带确认对话框；会话按名字绑定，归生效的那份） */
  deleteFile: (fileName: string) => void
  /**
   * 删掉一个找不到 bot 文件的名字下的全部会话（文件在 ShuviX 之外被删了，没机会级联；宿主自带确认对话框）。
   * 不给则那几组没有菜单
   */
  deleteSessions?: (name: string, count: number) => void
}

export interface BotRegistry {
  bots: BotGroupItem[]
  shadowed: BotGroupShadowedItem[]
  invalid: BotGroupInvalidFile[]
  archived?: string[]
}

/** 扫一遍并跟着变化重扫；没注入 adapter 时恒为 null。null 也表示「还没扫回来 / 一次都没扫成」 */
export function useBotRegistry(adapter: BotGroupAdapter | undefined): {
  registry: BotRegistry | null
  rescan: () => void
} {
  const [registry, setRegistry] = useState<BotRegistry | null>(null)
  // 递增序号丢弃过期回包（聚焦 / 事件 / 手动刷新并发时只认最后一次）
  const seq = useRef(0)

  const scan = useCallback(async (): Promise<void> => {
    if (!adapter) return
    const mine = ++seq.current
    try {
      const r = await adapter.list()
      if (mine === seq.current) setRegistry(r)
    } catch {
      // 扫失败（目录一时读不了之类）：留着上一次的清单。换成空清单会让每一条 bot 会话都读成「找不到 bot 文件」；
      // 一次都没扫成就还是 null，分节按会话里的 bot 名先把组列出来（见 ProjectSessionGroups），下次聚焦再扫
    }
  }, [adapter])

  useEffect(() => {
    // 挂上就扫：「Bots」分节常驻侧栏，组头要有名字（回包在微任务之后才写 state）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void scan()
    const onFocus = (): void => void scan()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [scan])

  // 宿主观察到的变更（笔记本写入 / 新建 / 删除）—— 不必等用户切窗口
  useAppEvent('bot.changed', () => void scan())

  return { registry: adapter ? registry : null, rescan: () => void scan() }
}
