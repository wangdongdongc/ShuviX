/**
 * 启动切换 —— pi-durable 切换之后，两类旧格式（`harness-v3-jsonl`）会话在启动时一次性处理掉。
 * 其余旧格式会话（普通对话、bot 对话、子会话）照旧只读可看，不在这里。
 *
 *  1. **绑着文件的会话原地重置**：`settings.notebookPath` 非空的旧格式行（项目笔记本、注册表 / 知识库 /
 *     记忆 / 技能笔记）经 `sessionRecords.updateStorageKind` 换成当前存储类型。id 不变 —— 侧栏选中、钉住、
 *     按 (项目, 笔记本路径) 找会话的入口都照旧拿到这一行；下一次打开建一份全新的 `.sqlite`，旧的笔记本对话
 *     不再显示（裁决 Q-P4-02：与「清空一条旧格式会话」同一语义，不是迁移）。`.jsonl` **留在盘上**、不再读，
 *     删除 / 清空这条会话时随 `deleteSessionStorage` 一起删。只动这一列：不打开存储、不建文件、不写镜像
 *     （PIN-14 / PIN-17：真正的旧格式行从没有镜像键；被拨回的库里曾是新格式的行，镜像就是它自己的状态）。
 *     它的旧格式子会话（自己没有 notebookPath）不动，照旧只读；子会话自己有 notebookPath 的照样重置（PIN-15）。
 *  2. **旧格式的 Chrome 标签页会话删掉**：绑定合法（`chromeTabOf`，PIN-06）的旧格式行逐条经
 *     `sessionService.delete`（裁决 Q-P4-03）—— 子会话、临时工作区、产物、`.jsonl` 由它级联。逐条 await
 *     （PIN-13）。既是标签页会话又有 notebookPath 的，删除优先（PIN-07），第 1 步跳过它。
 *
 * 幂等：处理过的行不再是旧格式，第二次启动什么都不做；降级再升级之后旧版本新建的那些行照样处理。不碰
 * `user_version`、不加迁移。在 main/index.ts 里于 IPC 注册之后、CLI 服务 / Chrome 桥 / 任何窗口之前 await ——
 * 那时还没有订阅，hub 不必替换一份活着的旧格式视图。
 *
 * **从不 reject**：单行失败记一条 warn、计入 failed，接着处理下一行；一步的查询抛错记 error，另一步照跑。
 * 每次恰一条 info 汇总（计数为 0 也记）。
 */
import { chromeTabOf } from '@shuvix/chat-protocol/chromeTabSession'
import { CURRENT_SESSION_STORAGE_KIND } from '@shuvix/chat-protocol/sessionStorageKind'
import { createLogger } from '../logger'
import { sessionRecords } from './sessionRecords'
import { sessionService } from './sessionService'

const log = createLogger('LegacySwitchover')

/** 一次切换的计数：重置了几条、删了几条、几条失败（失败的那条原样留着，下次启动再试） */
export interface LegacySwitchoverResult {
  reset: number
  deleted: number
  failed: number
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 第 1 步：绑着文件的旧格式会话逐条换成当前存储类型 */
function resetFileBound(result: LegacySwitchoverResult): void {
  for (const row of sessionRecords.findLegacyWithNotebookPath()) {
    // 同时是标签页会话的归第 2 步删（PIN-07）
    if (chromeTabOf(row.settings)) continue
    try {
      sessionRecords.updateStorageKind(row.id, CURRENT_SESSION_STORAGE_KIND)
      result.reset++
    } catch (error) {
      result.failed++
      log.warn(`重置旧格式笔记本会话失败 session=${row.id}: ${errorText(error)}`)
    }
  }
}

/** 第 2 步：旧格式的 Chrome 标签页会话逐条删掉（级联交给 sessionService.delete） */
async function deleteChromeTabs(result: LegacySwitchoverResult): Promise<void> {
  const ids = sessionRecords
    .findLegacyWithChromeTab()
    .filter((row) => chromeTabOf(row.settings))
    .map((row) => row.id)
  for (const id of ids) {
    // 前一条的级联已经把它删了（标签页会话的子会话自己也带着绑定）—— 不算删、也不算失败
    if (!sessionRecords.findById(id)) continue
    try {
      await sessionService.delete(id)
      result.deleted++
    } catch (error) {
      result.failed++
      log.warn(`删除旧格式标签页会话失败 session=${id}: ${errorText(error)}`)
    }
  }
}

/** 启动切换（见文件头）。从不 reject */
export async function runLegacySwitchover(): Promise<LegacySwitchoverResult> {
  const result: LegacySwitchoverResult = { reset: 0, deleted: 0, failed: 0 }
  try {
    resetFileBound(result)
  } catch (error) {
    log.error(`查找旧格式笔记本会话失败: ${errorText(error)}`)
  }
  try {
    await deleteChromeTabs(result)
  } catch (error) {
    log.error(`查找旧格式标签页会话失败: ${errorText(error)}`)
  }
  log.info(
    `旧格式会话启动切换: reset=${result.reset} deleted=${result.deleted} failed=${result.failed}`
  )
  return result
}
