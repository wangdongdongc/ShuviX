/**
 * 会话存储的桌面端入口 —— pi-durable 切换（P1-01）之后的过渡形态。
 *
 * 会话的对话内容按 `sessions.storageKind` 分流（见 chat-protocol 的 sessionStorageKind.ts）：
 *  - `durable-sqlite-1`（新会话）：pi-durable 的存储，`<sessionsDir>/<id>.sqlite`（WAL 旁带 -wal / -shm）。
 *    打开 / 关闭 / LRU 由 SessionHost 负责 —— TODO(pi-durable p1): P1-07（sessionHost）/ P1-10（桌面接线）。
 *  - `harness-v3-jsonl`（切换前的会话）：pi 0.80 的 v3 JSONL 会话树，`<sessionsDir>/<id>.jsonl`，
 *    **只读**：经 agent-runtime 的 legacy 读取器（不依赖 pi）渲染成界面消息，永不再写。
 *
 * 旧的进程内会话树缓存（getSessionTree / ensureSessionTree / 写锁 / 钉住谓词）随 pi 0.80 一起删除。
 *
 * **运行配置（模型 / 思考档位）改存会话设置**：`sessions.settings.model`（`{provider, modelId}`）与
 * `settings.thinkingLevel`。选择器无需为一个下拉框打开会话存储；会话是懒创建的 —— 从未发过消息的
 * 会话上照样能切模型。旧 v3 会话树里的 model_change / thinking_level_change 不再读。
 *
 * 分工与代价不变：`sessions` 表存业务字段，存储文件存对话。两处没有共同事务 —— 删除会话是
 * 「删表行 + unlink 文件」两步，中途崩溃会留下孤儿文件；刻意不做启动扫描兜底。
 */
import { join } from 'path'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { harnessV3TextToChatMessages, type LegacyTranscriptView } from '@shuvix/agent-runtime'
import { getSessionsDir } from '../utils/paths'
import { createLogger } from '../logger'
import { sessionRecords } from './sessionRecords'

const log = createLogger('SessionStorage')

/** 旧格式（harness-v3-jsonl）会话的转写文件绝对路径 */
export function sessionFilePath(sessionId: string): string {
  // sessionId 是 uuidv7，本身按时间有序 —— 无需时间戳前缀，也无需按 cwd 分目录
  return join(getSessionsDir(), `${sessionId}.jsonl`)
}

/** pi-durable 会话的 SQLite 存储文件绝对路径 */
export function durableStoragePath(sessionId: string): string {
  return join(getSessionsDir(), `${sessionId}.sqlite`)
}

// ─── 旧格式只读 ─────────────────────────────────────────────

/**
 * 读一条旧格式会话的界面消息（只读，每次现读现解析，不缓存）。
 *
 * 文件不存在（从未发过消息）→ null；会话头读不出来 → 记日志、null（与「没有转写」同样处理，
 * 界面显示空会话而不是报错页）。
 */
export function readLegacyTranscript(sessionId: string): LegacyTranscriptView | null {
  const path = sessionFilePath(sessionId)
  if (!existsSync(path)) return null
  try {
    const view = harnessV3TextToChatMessages(readFileSync(path, 'utf8'), sessionId)
    if (view.issues.length > 0) {
      log.warn(`旧会话 ${sessionId} 读取时跳过了 ${view.issues.length} 处问题`)
    }
    return view
  } catch (err) {
    log.warn(`旧会话 ${sessionId} 读取失败: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// ─── 运行配置：会话设置是唯一事实源 ─────────────────────────────

export interface SessionRunConfig {
  provider: string | null
  model: string | null
  thinkingLevel: string | null
}

/** 从会话设置读出当前运行配置；没设过的项为 null（调用方回落默认） */
export async function readSessionRunConfig(sessionId: string): Promise<SessionRunConfig> {
  const settings = sessionRecords.pickSettings(sessionId, ['model', 'thinkingLevel'])
  return {
    provider: settings?.model?.provider ?? null,
    model: settings?.model?.modelId ?? null,
    thinkingLevel: settings?.thinkingLevel ?? null
  }
}

/** 记下会话选定的模型（选择器 / 子会话继承父会话） */
export async function appendModelChange(
  sessionId: string,
  provider: string,
  modelId: string
): Promise<void> {
  sessionRecords.updateSettings(sessionId, { model: { provider, modelId } })
}

/** 记下会话选定的思考档位 */
export async function appendThinkingLevelChange(
  sessionId: string,
  thinkingLevel: string
): Promise<void> {
  sessionRecords.updateSettings(sessionId, { thinkingLevel })
}

// ─── 删除 ────────────────────────────────────────────────

/**
 * 删除某会话的全部存储文件（幂等）：pi-durable 的 `<id>.sqlite` 连同 WAL 的 `-wal` / `-shm`，
 * 以及旧格式的 `<id>.jsonl`。哪种都可能存在 —— 删的是这条会话，不是某一种格式。
 * TODO(pi-durable p1): P1-07/P1-10 先经 SessionHost 关掉打开着的存储再删。
 */
export function deleteSessionFile(sessionId: string): void {
  const sqlite = durableStoragePath(sessionId)
  for (const path of [sqlite, `${sqlite}-wal`, `${sqlite}-shm`, sessionFilePath(sessionId)]) {
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch (err) {
      log.warn(`删除会话文件失败 ${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
