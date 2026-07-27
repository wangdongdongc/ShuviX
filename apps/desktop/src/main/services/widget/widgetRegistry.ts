/**
 * WidgetRegistry —— widget 的真源，全部落在文件系统上（替代已废弃的 widgets 表）。
 *
 * 布局：
 *   ~/.shuvix/widgets/
 *     .config.json            宿主账目：{ state: { <id>: { updatedAt, lastOpenedAt, archivedAt } } }
 *     <id>/widget.json        身份清单：{ id, name, description, entryFile, createdAt }
 *     <id>/schema.sql         DB schema（由 widgetService 维护，不在本文件职责内）
 *
 * 为什么这么分（与 skillService / agentService 的先例一致）：
 *   - 清单是作者性的、低频变更的，跟着 widget 目录走 —— 目录拷到别处仍是一个完整 widget，
 *     而且它在 widget 自己的 git 仓库里被版本化；
 *   - 账目是宿主的、每次打开就变的，必须留在 widget 目录**之外**：写进被跟踪的
 *     widget.json 会让每个 widget 仓库永远是脏的，agent 每个任务都要开一条
 *     diff 只有时间戳的垃圾基线提交（见 widgetRepo 与 widget 子代理政策第 8 节）。
 *
 * 目录名即 id：清单里的 id 与目录名不符时以目录名为准 —— 路由、URL、窗口状态键
 * 全部按目录名解析，让一个被改坏的清单凭空造出一个 id 只会更糟。
 *
 * 容错：单个 widget 的清单缺失或损坏时跳过该项并记日志，不让整个列表挂掉
 * （对齐原先 DAO 里 metadata JSON 解析失败降级为空对象的宽容度）。
 */

import { readdirSync, readFileSync, rmSync, statSync, type Dirent } from 'fs'
import { join } from 'path'
import { getWidgetsDir } from '../../utils/paths'
import { writeFileAtomic } from '../../utils/atomicWrite'
import { createLogger } from '../../logger'

const log = createLogger('WidgetRegistry')

/** widget id 规范：kebab-case 且至少含一个短横（同时也是目录名的合法性判据） */
export const WIDGET_ID_REGEX = /^[a-z0-9]+(-[a-z0-9]+)+$/

const CONFIG_FILE = '.config.json'
const MANIFEST_FILE = 'widget.json'

/** widget 记录 —— 清单字段 + 宿主账目字段的合并视图 */
export interface Widget {
  id: string
  name: string
  description: string
  entryFile: string
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  archivedAt: number
}

/** 落盘的身份清单 */
type Manifest = Pick<Widget, 'id' | 'name' | 'description' | 'entryFile' | 'createdAt'>

/** 落盘的宿主账目（每个 widget 一条） */
interface WidgetState {
  updatedAt: number
  lastOpenedAt: number
  archivedAt: number
  /**
   * 最近一次**成功应用过**的 schema.sql 内容指纹。
   * schema.sql 本身是 agent 可写、且随 git 回退的普通源文件，不能拿它无条件重放；
   * 只有指纹对得上，才说明文件里的 DDL 确实在这台机器上跑通过（见 widgetService 的重放逻辑）。
   */
  schemaHash: string
}

interface ConfigFile {
  state: Record<string, Partial<WidgetState>>
}

const DEFAULT_STATE: WidgetState = {
  updatedAt: 0,
  lastOpenedAt: 0,
  archivedAt: 0,
  schemaHash: ''
}

function configPath(): string {
  return join(getWidgetsDir(), CONFIG_FILE)
}

function manifestPath(id: string): string {
  return join(getWidgetsDir(), id, MANIFEST_FILE)
}

/**
 * 读账目。返回 undefined 表示"文件在、但读不出来"。
 *
 * 必须把这种情况和"文件还不存在"区分开：账目是 archivedAt 的**唯一**存放处
 * （v13 删表后没有第二份），读失败时若按空对象继续，下一次任何写入都会把这个空对象
 * 落盘，等于静默清掉所有 widget 的归档状态。所以读不出来时宁可不写。
 */
function readConfig(): ConfigFile | undefined {
  try {
    const raw = readFileSync(configPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ConfigFile>
    return { state: parsed.state && typeof parsed.state === 'object' ? parsed.state : {} }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: {} } // 首次运行
    log.warn(
      `widget 账目不可读（${(err as Error).message}）—— 本次按空账目降级展示，且跳过写入以免清空归档状态`
    )
    return undefined
  }
}

function writeConfig(config: ConfigFile): void {
  try {
    writeFileAtomic(configPath(), JSON.stringify(config, null, 2) + '\n')
  } catch (err) {
    log.warn(`写入 widget 账目失败: ${(err as Error).message}`)
  }
}

function normalizeState(raw: Partial<WidgetState> | undefined): WidgetState {
  if (!raw) return { ...DEFAULT_STATE }
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    updatedAt: num(raw.updatedAt),
    lastOpenedAt: num(raw.lastOpenedAt),
    archivedAt: num(raw.archivedAt),
    schemaHash: typeof raw.schemaHash === 'string' ? raw.schemaHash : ''
  }
}

/** 读单个 widget 的清单；缺失 / 损坏 / 字段不合法都返回 undefined（调用方跳过该项） */
function readManifest(id: string): Manifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(id), 'utf-8')) as Partial<Manifest>
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    const entryFile = str(parsed.entryFile) || 'index.tsx'
    const createdAt =
      typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt)
        ? parsed.createdAt
        : 0
    // 目录名即 id；清单里的 id 只在不一致时记一条日志
    if (parsed.id && parsed.id !== id) {
      log.warn(`widget ${id} 的清单里 id 写着 "${parsed.id}"，以目录名为准`)
    }
    return {
      id,
      name: str(parsed.name) || id,
      description: str(parsed.description),
      entryFile,
      createdAt
    }
  } catch (err) {
    // ENOENT = 这个目录本来就不是 widget，静默跳过；其余（损坏 JSON / 权限 / IO）都要留痕，
    // 否则 widget 会从列表里凭空消失且毫无线索
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`widget ${id} 的 ${MANIFEST_FILE} 读取失败，已跳过: ${(err as Error).message}`)
    }
    return undefined
  }
}

function writeManifest(m: Manifest): void {
  writeFileAtomic(manifestPath(m.id), JSON.stringify(m, null, 2) + '\n')
}

/** 符号链接是否指向一个目录（断链 / 无权限一律当作否） */
function isDirThroughLink(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function toWidget(m: Manifest, state: WidgetState): Widget {
  const { updatedAt, lastOpenedAt, archivedAt } = state
  return { ...m, updatedAt, lastOpenedAt, archivedAt }
}

class WidgetRegistry {
  /** 扫描 widgets 根目录，返回全部可识别的 widget（含归档） */
  listAll(): Widget[] {
    const root = getWidgetsDir()
    const config = readConfig() ?? { state: {} }
    const out: Widget[] = []
    let entries: Dirent[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch (err) {
      log.warn(`扫描 widgets 目录失败: ${(err as Error).message}`)
      return out
    }
    for (const entry of entries) {
      // 只认目录；.config.json 等文件与非法目录名一律忽略。
      // 符号链接要跟随判断 —— findById 直接 readFileSync 是跟随的，两处口径不一致
      // 会造成"列表里没有、但各种操作都还能用"的幽灵 widget。
      if (!WIDGET_ID_REGEX.test(entry.name)) continue
      if (
        !entry.isDirectory() &&
        !(entry.isSymbolicLink() && isDirThroughLink(join(root, entry.name)))
      )
        continue
      const manifest = readManifest(entry.name)
      if (!manifest) continue
      out.push(toWidget(manifest, normalizeState(config.state[entry.name])))
    }
    return out
  }

  /** 未归档，按最近打开倒序（没打开过的按创建时间倒序） */
  findAllActive(): Widget[] {
    return this.listAll()
      .filter((w) => w.archivedAt === 0)
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || b.createdAt - a.createdAt)
  }

  /** 已归档，按归档时间倒序 */
  findAllArchived(): Widget[] {
    return this.listAll()
      .filter((w) => w.archivedAt > 0)
      .sort((a, b) => b.archivedAt - a.archivedAt)
  }

  findById(id: string): Widget | undefined {
    if (!WIDGET_ID_REGEX.test(id)) return undefined
    const manifest = readManifest(id)
    if (!manifest) return undefined
    return toWidget(manifest, normalizeState(readConfig()?.state[id]))
  }

  /** 新建：写清单 + 建账目条目 */
  insert(widget: Widget): void {
    writeManifest({
      id: widget.id,
      name: widget.name,
      description: widget.description,
      entryFile: widget.entryFile,
      createdAt: widget.createdAt
    })
    this.patchState(widget.id, {
      updatedAt: widget.updatedAt,
      lastOpenedAt: widget.lastOpenedAt,
      archivedAt: widget.archivedAt
    })
  }

  /**
   * 更新：name/description/entryFile 落清单，archivedAt 落账目；任一变更都刷新 updatedAt。
   * 清单不存在（widget 已被删）时静默跳过，避免凭空造出一个只有清单的目录。
   */
  update(
    id: string,
    fields: Partial<Pick<Widget, 'name' | 'description' | 'entryFile' | 'archivedAt'>>
  ): void {
    const manifest = readManifest(id)
    if (!manifest) return
    if (
      fields.name !== undefined ||
      fields.description !== undefined ||
      fields.entryFile !== undefined
    ) {
      writeManifest({
        ...manifest,
        ...(fields.name !== undefined ? { name: fields.name } : {}),
        ...(fields.description !== undefined ? { description: fields.description } : {}),
        ...(fields.entryFile !== undefined ? { entryFile: fields.entryFile } : {})
      })
    }
    this.patchState(id, {
      ...(fields.archivedAt !== undefined ? { archivedAt: fields.archivedAt } : {}),
      updatedAt: Date.now()
    })
  }

  /**
   * 打开时刷新 lastOpenedAt。
   * 刻意不动 updatedAt —— "打开"不是"修改"，原先 DAO 里一起 bump 只是实现巧合。
   */
  markOpened(id: string): void {
    this.patchState(id, { lastOpenedAt: Date.now() })
  }

  /** 删除账目条目（目录本身由 widgetService 负责移除） */
  deleteById(id: string): void {
    const config = readConfig()
    if (!config || config.state[id] === undefined) return
    delete config.state[id]
    writeConfig(config)
  }

  /** 读取最近一次成功应用的 schema 指纹（无记录返回空串） */
  getSchemaHash(id: string): string {
    return normalizeState(readConfig()?.state[id]).schemaHash
  }

  /** 记录刚刚成功应用的 schema 指纹 */
  setSchemaHash(id: string, hash: string): void {
    this.patchState(id, { schemaHash: hash, updatedAt: Date.now() })
  }

  /** 清单文件绝对路径 —— widgetService 判断"目录里是不是一个 widget"时用 */
  manifestPathOf(id: string): string {
    return manifestPath(id)
  }

  /** 读-改-写账目：全部账目写入的唯一入口，便于将来加锁 */
  private patchState(id: string, patch: Partial<WidgetState>): void {
    const config = readConfig()
    if (!config) return // 账目读不出来，宁可丢这次更新也不能覆盖成空
    config.state[id] = { ...normalizeState(config.state[id]), ...patch }
    writeConfig(config)
  }
}

export const widgetRegistry = new WidgetRegistry()

/** 供测试 / 排障：彻底移除账目文件 */
export function removeConfigFile(): void {
  try {
    rmSync(configPath(), { force: true })
  } catch {
    // 忽略
  }
}
