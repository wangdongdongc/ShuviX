/**
 * md 扩展元数据的笔记入口 —— 属性卡「ShuviX 设置」条经 IPC（`mdMeta:*`）读写一份注册表文件的补缺值。
 * 设计见 docs/md-metadata-design.md；契约在 chat-protocol `mdMeta.ts`，数据在 services/mdMeta。
 *
 * 规则（全部在主进程判，渲染进程只发意图）：
 *   - **按笔记本会话认文件**：路径只由注册表载体目录 + 会话的文件名拼出（registryNoteFileOf），不收渲染进程的路径；
 *   - **先有 id，才有元数据**：读**磁盘上**的文件，`shuvix-id` 必须就是渲染进程以为的那个 —— 插入 id 的那次
 *     保存还没落盘、或 id 已被换掉，一律拒绝（no-object-id），免得写到别的对象上或挂在一个不存在的 id 下；
 *   - **只补白名单里的键**（MD_FM_FILL_KEYS），值交给这类文件自己的解析器校验，不合法不写；
 *   - 写入只有这一个入口，且只由人在界面上触发：没有工具、没有 CLI 写命令 —— 补缺值改变 agent 的运行方式，
 *     不能让 agent 自己改；
 *   - 写完广播这类文件已有的 `*.changed`，侧栏与属性卡照常重查；运行时每次现取（注册表现扫 + 快照），即刻生效。
 */
import { readFileSync } from 'fs'
import { parse as parseYaml } from 'yaml'
import { frontmatterOf } from '@shuvix/chat-protocol/shuvixMdContract'
import {
  MD_FM_FILL_KEYS,
  SHUVIX_ID_KEY,
  isDeclared,
  isJsonValue,
  normalizeObjectId,
  type MdMetaNoteView,
  type MdMetaWriteResult,
  type MdObjectKind
} from '@shuvix/chat-protocol/mdMeta'
import { validateAgentFill } from '@shuvix/agent-runtime'
import { appEventBus } from '../utils/appEventBus'
import { mdMetaStore } from './mdMeta'
import { registryNoteFileOf, type RegistryNoteFile } from './registryNotes'

/** 磁盘上这份文件的 frontmatter 字段；读不到、没有 frontmatter、YAML 写坏或不是映射 → 空对象 */
function readFields(absPath: string): Record<string, unknown> {
  try {
    const yaml = frontmatterOf(readFileSync(absPath, 'utf-8'))
    if (yaml === null) return {}
    const parsed: unknown = parseYaml(yaml)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** 这份文件的对象 id 与状态（与解析器同一判定：写错 = 没有 id） */
function idOf(fields: Record<string, unknown>): Pick<MdMetaNoteView, 'objectId' | 'idStatus'> {
  if (!(SHUVIX_ID_KEY in fields)) return { objectId: null, idStatus: 'none' }
  const objectId = normalizeObjectId(fields[SHUVIX_ID_KEY])
  return objectId ? { objectId, idStatus: 'ok' } : { objectId: null, idStatus: 'malformed' }
}

/** 这组补缺值这类文件的解析器收不收；返回拒绝原因，null = 收（没有可补键的类型恒为 null） */
function validateFill(kind: MdObjectKind, fill: Record<string, unknown>): string | null {
  if (Object.keys(fill).length === 0) return null
  return kind === 'agent' ? validateAgentFill(fill) : null
}

/**
 * 存之前把值归一成解析器读出来的样子（字符串去首尾空白，思考档位转小写）—— 解析器读时本来也会归一，
 * 存归一后的值，属性卡的下拉才不会多出一个 `HIGH` 之类的「表外」选项
 */
function normalizeFillValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return key === 'shuvix-thinking' ? trimmed.toLowerCase() : trimmed
}

/** 写完广播这类文件已有的变更事件 */
function publishChanged(kind: MdObjectKind): void {
  appEventBus.publish({ type: `${kind}.changed` })
}

/** 一份注册表笔记的元数据视图；不是注册表笔记 → null */
export function noteView(sessionId: string): MdMetaNoteView | null {
  if (typeof sessionId !== 'string') return null
  const note = registryNoteFileOf(sessionId)
  if (!note) return null
  const fields = readFields(note.absPath)
  const { objectId, idStatus } = idOf(fields)
  const fillKeys = [...MD_FM_FILL_KEYS[note.kind]]
  const fill = objectId ? (mdMetaStore.fillFor(objectId, note.kind) ?? {}) : {}
  const declared = fillKeys.filter((key) => isDeclared(fields, key))
  // 真正会被补进去的那部分（文件写了的键不补）—— 解析器不收它们时，补缺整体不生效
  const effective = Object.fromEntries(Object.entries(fill).filter(([k]) => !declared.includes(k)))
  const rejected = validateFill(note.kind, effective)
  return {
    kind: note.kind,
    objectId,
    idStatus,
    fillKeys,
    fill,
    declared,
    warnings: rejected ? [rejected] : [],
    readOnly: note.builtin
  }
}

type Checked =
  | { note: RegistryNoteFile; objectId: string }
  | Extract<MdMetaWriteResult, { success: false }>

/** 写入前的共同校验：是注册表笔记、键在白名单里、磁盘上的 id 就是渲染进程以为的那个 */
function check(sessionId: unknown, objectId: unknown, key: unknown): Checked {
  const note = typeof sessionId === 'string' ? registryNoteFileOf(sessionId) : null
  if (!note) return { success: false, reason: 'not-registry-note' }
  if (typeof key !== 'string' || !MD_FM_FILL_KEYS[note.kind].includes(key)) {
    return { success: false, reason: 'key-not-allowed' }
  }
  const expected = normalizeObjectId(objectId)
  const onDisk = idOf(readFields(note.absPath)).objectId
  if (!expected || onDisk !== expected) return { success: false, reason: 'no-object-id' }
  return { note, objectId: expected }
}

/** 写一个补缺值。空白字符串不算值（等于没设）—— 要清掉用 unsetNoteFill */
export function setNoteFill(params: {
  sessionId: string
  objectId: string
  key: string
  value: unknown
}): MdMetaWriteResult {
  const checked = check(params?.sessionId, params?.objectId, params?.key)
  if (!('note' in checked)) return checked
  const { key } = params
  const value = normalizeFillValue(key, params.value)
  if (value === null || !isJsonValue(value) || value === '') {
    return { success: false, reason: 'invalid-value', message: 'empty or non-JSON value' }
  }
  const rejected = validateFill(checked.note.kind, { [key]: value })
  if (rejected) return { success: false, reason: 'invalid-value', message: rejected }
  mdMetaStore.setFill(checked.objectId, key, value)
  publishChanged(checked.note.kind)
  return { success: true }
}

/** 删一个补缺值（本来就没有也算成功 —— 结果一样是「没设」） */
export function unsetNoteFill(params: {
  sessionId: string
  objectId: string
  key: string
}): MdMetaWriteResult {
  const checked = check(params?.sessionId, params?.objectId, params?.key)
  if (!('note' in checked)) return checked
  if (mdMetaStore.unsetFill(checked.objectId, params.key)) publishChanged(checked.note.kind)
  return { success: true }
}
