import { getChatApi, useChatStore } from '@shuvix/chat-ui'
import { REGISTRY_NOTE_PROJECT_IDS } from '@shuvix/chat-protocol/registryNotes'
import type { BotGroupItem, BotSessionLocation } from '@shuvix/app-shell'

/**
 * bot 组上那几个动作（编辑 bot / 新建 bot / 新对话 / 归档）—— 侧栏的会话列表与日历视图里的 bot 组共用这几个函数，
 * 两处点同一个菜单得到同一个结果。删文件 / 删一组会话要宿主自己的确认框，不在这里。
 *
 * 「编辑 bot」/ 新建一份都是打开那份文件的**笔记本会话**（main 侧去重，隐藏项目 `__bots__`）；「新对话」建的是一条
 * **普通有根会话**（`settings.bot`，只归属 bot，选的项目记成工作项目的引用）。`select` 收到要选中的会话 id（null =
 * 离开当前会话）；它在动作里才调，所以由调用方在适配器的闭包里传进来（不在渲染时传给函数 —— React 编译器的
 * refs 规则会把那当成读 ref）
 */
type Select = (id: string | null) => void

export async function openBotNote(
  fileName: string,
  title: string | undefined,
  select: Select
): Promise<void> {
  let session: { id: string }
  try {
    session = await window.api.bot.openNote({ fileName, title })
  } catch {
    return // 文件已不在（清单过期）—— bot.changed / 聚焦重扫会把这一行拿掉
  }
  useChatStore.getState().setSessions(await getChatApi().session.list())
  select(session.id)
}

/** 按模板新建一份 bot 文件并打开它的笔记本 */
export async function createBot(select: Select): Promise<void> {
  const r = await window.api.bot.createNew()
  if (r.success && r.fileName) await openBotNote(r.fileName, r.name, select)
}

/** 和这个 bot 在选定的位置新建一条会话并选中它 */
export async function newBotSession(
  name: string,
  location: BotSessionLocation,
  select: Select
): Promise<void> {
  const session = await getChatApi().session.create({
    bot: name,
    ...('workProject' in location ? { workProject: location.workProject } : {})
  })
  useChatStore.getState().setSessions(await getChatApi().session.list())
  select(session.id)
}

/** 归档 bot；正开着这份 bot 文件的笔记本时先离开它（主进程归档时会把那条笔记本会话删掉） */
export function archiveBot(bot: BotGroupItem, select: Select): void {
  const { sessions, activeSessionId } = useChatStore.getState()
  const active = sessions.find((s) => s.id === activeSessionId)
  if (
    active?.projectId === REGISTRY_NOTE_PROJECT_IDS.bot &&
    active.settings.notebookPath === bot.fileName
  ) {
    select(null)
  }
  void window.api.bot.archive({ name: bot.name })
}

/** 选一个文件夹并加成项目（已存在同路径则复用），回项目 id；取消回 null —— bot 位置选择里的「打开文件夹…」 */
export async function pickFolderAsProject(): Promise<string | null> {
  const folder = await window.api.app.openDirectoryDialog()
  if (!folder) return null
  const existing = (await getChatApi().project.list()).find((p) => p.path === folder)
  return existing?.id ?? (await getChatApi().project.create({ path: folder })).id
}
