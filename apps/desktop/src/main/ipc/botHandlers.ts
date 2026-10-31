import { basename } from 'path'
import { boundBotOf } from '@shuvix/chat-protocol/botSession'
import { REGISTRY_NOTE_PROJECT_IDS } from '@shuvix/chat-protocol/registryNotes'
import { sessionRecords } from '../services/sessionRecords'
import { defineHandler } from './registry'
import { botService, type BotEntry } from '../services/botService'
import { openRegistryNote } from '../services/registryNotes'
import { sessionService } from '../services/sessionService'

/** 绑定这个 bot 名的顶层 bot 会话（子会话随父会话级联，不单列） */
function botSessionIds(name: string): string[] {
  return sessionService
    .list()
    .filter((s) => !s.parentId && boundBotOf(s.settings) === name)
    .map((s) => s.id)
}

/** 一个 bot 名此刻还有没有主人：生效的、或归档里的哪一份文件叫这个名字 */
function botNameHeld(name: string): boolean {
  return !!botService.get(name) || botService.listArchived().some((b) => b.name === name)
}

/** 删掉这些会话（逐条走 sessionService.delete：运行时、临时工作区、权限表、子会话一并清掉） */
async function deleteSessions(ids: string[]): Promise<number> {
  for (const id of ids) await sessionService.delete(id)
  return ids.length
}

/** 侧栏一行 bot 的投影（渲染侧类型见 preload 的 BotInfo） */
interface BotListRow {
  name: string
  displayName: string
  description: string
  basePath: string
  fileName: string
}

/**
 * Bot IPC 处理器 —— 主窗口侧栏「Bots」分节与 设置 → 已归档 → Bots。
 *
 * 纯 md 驱动：每次 list 现扫 `~/.shuvix/bots`。**编辑不在这里**：打开一份 bot 就是打开 / 复用它的
 * 笔记本会话（`bot:openNote`，与知识库条目同一条路），改动由笔记本自动保存落盘，改名迁移与
 * `bot.changed` 由 botService 在写入回执里补上。没有启用开关，文件存在且合法即可用；**不内置 bot**，
 * 新建走 `bot:createNew`（按模板落一份新文件）。
 */
export function registerBotHandlers(): void {
  /**
   * 列出全部 bot：生效的 + 被同名遮蔽的 + 解析不过的，一次取齐（侧栏一次扫描就够）。生效与遮蔽出自
   * 同一次同名裁决（botService.scanDir）—— 绑定会话、身份胶囊只认 `bots`，侧栏把三拨都列出来
   */
  defineHandler('bot:list', () => {
    const { valid, shadowed, invalid } = botService.listWithInvalid()
    const info = (b: BotEntry): BotListRow => ({
      name: b.file.name,
      displayName: b.file.displayName,
      description: b.file.description,
      basePath: b.basePath,
      fileName: basename(b.basePath)
    })
    return {
      bots: valid.map(info),
      shadowed: shadowed.map((b) => ({ ...info(b), shadowedBy: b.shadowedBy })),
      invalid,
      // 归档了的 bot 名：侧栏把它们的会话一起藏起来（与归档项目一样），不当成「找不到文件」
      archived: [...new Set(botService.listArchived().map((b) => b.name))]
    }
  })

  /** 打开 / 复用一份 bot 文件的笔记本会话（按文件名认 —— 解析不过的文件也这样打开去修） */
  defineHandler('bot:openNote', (_e, params: { fileName: string; title?: string }) =>
    openRegistryNote('bot', params.fileName, params.title)
  )

  /** 按模板新建一份 bot 文件（名字取第一个没被占用的 my-bot / my-bot-2 ……），回名字与文件名 */
  defineHandler('bot:createNew', () => botService.createNew())

  /** 归档：把生效的那份 bot 文件挪进 bots 目录的 `archived/`（它的会话一起从侧栏里藏起来，能恢复） */
  defineHandler('bot:archive', async (_e, params: { name: string }) => {
    const file = botService.get(params.name)?.basePath
    const r = botService.archive(params.name)
    // 那份文件的笔记本会话一并删掉：开着它接着打字，自动保存会把文件写回 bots 目录，bot 就又「活」了
    if (r.success && file) {
      const note = sessionRecords.findByProjectAndNotebookPath(
        REGISTRY_NOTE_PROJECT_IDS.bot,
        basename(file)
      )
      if (note) await sessionService.delete(note.id)
    }
    return r
  })

  /** 归档了的 bot（设置 → 已归档 → Bots），各带它名下的会话条数（删除的确认框要说清楚会删多少） */
  defineHandler('bot:listArchived', () =>
    botService.listArchived().map((b) => ({ ...b, sessionCount: botSessionIds(b.name).length }))
  )

  /** 恢复：从 `archived/` 挪回 bots 目录 */
  defineHandler('bot:restore', (_e, params: { fileName: string }) =>
    botService.restore(params.fileName)
  )

  /**
   * 删除一个归档了的 bot：文件连同它的会话（用户 2026-10-30：与项目一样，删 bot 就是连会话一起删）。同名的另一份
   * 还在（生效的、或归档里的另一份）时只删文件 —— 会话按名字绑定，它们属于留下的那份
   */
  defineHandler('bot:deleteArchived', async (_e, params: { fileName: string }) => {
    const r = botService.deleteArchivedFile(params.fileName)
    if (!r.success || !r.name) return { ...r, deletedSessions: 0 }
    const deletedSessions = botNameHeld(r.name) ? 0 : await deleteSessions(botSessionIds(r.name))
    return { success: true, deletedSessions }
  })

  /**
   * 删除一个找不到 bot 文件的名字下的全部会话（文件在 ShuviX 之外被删了，没机会级联）。这个名字此刻还有主人
   * （生效的或归档里的文件）时拒绝 —— 那些会话不是孤儿
   */
  defineHandler('bot:deleteSessions', async (_e, params: { name: string }) => {
    if (botNameHeld(params.name)) {
      return { success: false, deletedSessions: 0, error: `Bot "${params.name}" still exists` }
    }
    return { success: true, deletedSessions: await deleteSessions(botSessionIds(params.name)) }
  })

  /** 按文件名删除解析不过的文件（它没有 name） */
  defineHandler('bot:deleteByFile', (_e, params: { fileName: string }) =>
    botService.deleteByFile(params.fileName)
  )

  /** 打开 bots 目录（OS 文件管理器） */
  defineHandler('bot:openFolder', async () => {
    await botService.openFolder()
    return { success: true }
  })
}
