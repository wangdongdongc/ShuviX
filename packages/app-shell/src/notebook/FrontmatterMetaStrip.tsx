/**
 * 属性卡里的「ShuviX 设置」条 —— md 扩展元数据（chat-protocol mdMeta.ts，设计 docs/md-metadata-design.md）。
 *
 * 一份 agent / bot / hook / policy 文件可以由数据库补上它**没写**的 frontmatter 键（目前只有 agent 的模型与
 * 思考档位）。每个能补的键一个控件（复用卡片字段槽位里那几个选择器），改的是数据库，不是文件 —— 所以内置
 * 文件（编辑器只读）照样能改；文件里写了的键注明「以文件为准」；补缺值没能生效时写明原因。
 *
 * 设置只认文件的对象 id（`shuvix-id`），但**用户不必管它**：还没有 id 的文件，第一次改设置时自动分配一个
 * （写一行进文件，见 metaWriteQueue）。等 id 落盘、再写设置的过程在组件外面跑 —— 写 id 会让卡片重建、
 * 本组件重挂；任何一个实例都从队列读在途的值与「正在保存」。
 *
 * 卡片是纯 DOM 的 CM6 widget，本组件由 LivePreviewEditor 挂进卡片给的槽位（独立 React root）。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { parse as parseYaml } from 'yaml'
import { getChatApi } from '@shuvix/chat-ui'
import { SHUVIX_ID_KEY, normalizeObjectId, type MdMetaNoteView } from '@shuvix/chat-protocol/mdMeta'
import { descriptorForType } from '@shuvix/chat-protocol/shuvixMdDescriptors'
import { InfoHint } from '../settings/SettingsPrimitives'
import { FrontmatterFieldPicker } from './FrontmatterFieldPicker'
import {
  metaWriteState,
  requestMetaWrite,
  requestNewObjectId,
  subscribeMetaWrites,
  type MetaWriteError
} from './metaWriteQueue'

export interface FrontmatterMetaStripProps {
  /** 这份文件的笔记本会话 —— 主进程按它认文件 */
  sessionId: string
  markerType: string
  /** 缓冲区里的 frontmatter 原文 */
  yaml: string
  /** 编辑器只读：改不了文件（不能写 id），数据库里的设置照样能改 */
  readOnly: boolean
  /** 往缓冲区写 `shuvix-id` 并尽快落盘；frontmatter 改不了一行时返回 false */
  setObjectId: (id: string) => boolean
}

// 与 frontmatterCard.ts 的行样式同一套话（标签列宽、行高、弱色小字）—— 改那边要一起改
const ROW = 'flex items-start gap-3 px-1 py-px'
const LABEL = 'w-[140px] shrink-0 truncate text-[12px] leading-6 text-text-tertiary'
const LINK_BUTTON =
  'shrink-0 text-[11px] text-text-tertiary hover:text-text-primary disabled:opacity-50 disabled:hover:text-text-tertiary'

/**
 * 缓冲区 frontmatter 里的 id：有且合法 → id；没写或写错 → null（第一次改设置时自动分配 / 换掉）；
 * YAML 解析不了 → 'unparseable'（这时读不出它有没有 id —— 自动分配会把一行合法的 id 悄悄换掉）
 */
function bufferIdOf(yaml: string): string | 'unparseable' | null {
  let fields: unknown
  try {
    fields = parseYaml(yaml)
  } catch {
    return 'unparseable'
  }
  if (fields === null || fields === undefined) return null
  if (typeof fields !== 'object' || Array.isArray(fields)) return 'unparseable'
  return normalizeObjectId((fields as Record<string, unknown>)[SHUVIX_ID_KEY])
}

/**
 * 每个会话最近一次问到的视图，连同问它时队列的版本。写 id 会让卡片重建、本组件重挂 —— 新挂上的实例
 * 先拿它画出来，不必空白一下等自己那次查询回来
 */
interface FetchedView {
  sessionId: string
  view: MdMetaNoteView | null
  /** 发起这次查询时队列的版本 */
  version: number
}
const lastViews = new Map<string, FetchedView>()

/** 补缺值 → 选择器要的单行原始值（模型 ref / 档位名）；非字符串值原样字符串化 */
function controlValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function FrontmatterMetaStrip({
  sessionId,
  markerType,
  yaml,
  readOnly,
  setObjectId
}: FrontmatterMetaStripProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const bufferId = useMemo(() => bufferIdOf(yaml), [yaml])
  const writes = useSyncExternalStore(
    (listener) => subscribeMetaWrites(sessionId, listener),
    () => metaWriteState(sessionId)
  )
  const [fetched, setFetched] = useState<FetchedView | null>(() => lastViews.get(sessionId) ?? null)

  // 数据库里的设置：挂上时问一次，队列每有变化（写完一项、id 落盘、失败）再问 —— 只在拿到结果后 setState
  useEffect(() => {
    const api = getChatApi().mdMeta
    if (!api) return undefined
    let alive = true
    const version = writes.version
    const settle = (view: MdMetaNoteView | null): void => {
      const next = { sessionId, view, version }
      const cached = lastViews.get(sessionId)
      if (!cached || cached.version <= version) lastViews.set(sessionId, next)
      if (alive) setFetched(next)
    }
    api.get({ sessionId }).then(settle, () => settle(null))
    return () => {
      alive = false
    }
  }, [sessionId, writes.version])

  // 换了会话就不拿上一个会话的视图来画
  const view = fetched?.sessionId === sessionId ? fetched.view : undefined

  // 还没问到 / 不是注册表笔记 / 这类文件没有能补的键：整条不出现。frontmatter 写坏了也不出现 ——
  // 卡片已经亮了 YAML 错误，此时读不出缓冲区里有没有 id，自动分配只会把一行合法的 id 换掉。
  // 只读又没有 id（随包发布的内置都带 id，几乎走不到）：写不进 id，也就存不了设置
  if (!view || view.fillKeys.length === 0 || bufferId === 'unparseable') return null
  if (readOnly && !bufferId) return null

  const labels = descriptorForType(markerType)?.fields ?? []
  const labelOf = (key: string): string => {
    const spec = labels.find((f) => f.key === key)
    return spec ? t(spec.labelKey) : key
  }
  // 磁盘上就是缓冲区里这个 id 时，数据库里的设置才是这份文件的（刚换新 id、还没落盘时不是）
  const stored = bufferId && view.objectId === bufferId ? view.fill : {}
  // 视图是在队列最近一次变化之前问到的（重查还在路上）：刚写进去的值以队列记的为准，免得控件闪回旧值
  const viewIsStale =
    !fetched || fetched.sessionId !== sessionId || fetched.version < writes.version
  const valueOf = (key: string): string => {
    if (writes.pending?.has(key)) return writes.pending.get(key) ?? ''
    if (viewIsStale && writes.written.has(key)) return writes.written.get(key) ?? ''
    return controlValue(stored[key])
  }
  const errorText = (error: MetaWriteError): string =>
    error.kind === 'cannot-assign'
      ? t('notebook.frontmatter.metaCannotAssign')
      : error.kind === 'not-saved'
        ? t('notebook.frontmatter.metaNotSaved')
        : t('notebook.frontmatter.metaWriteFailed', { reason: error.message ?? error.reason })

  return (
    <div className="cm-shuvix-fmcard-meta-strip mt-2 pt-1.5 border-t border-border-secondary/40">
      <div className="flex items-center gap-2 h-6 px-1">
        <span className="text-[11px] font-medium tracking-wide text-text-tertiary">
          {t('notebook.frontmatter.metaTitle')}
        </span>
        <InfoHint hint={t('notebook.frontmatter.metaHint')} />
        <div className="flex-1" />
        {bufferId && (
          <span
            className="cm-shuvix-fmcard-meta-id truncate max-w-[220px] text-[11px] font-mono text-text-tertiary/80"
            title={`${t('notebook.frontmatter.objectId')}: ${bufferId}`}
          >
            {bufferId}
          </span>
        )}
        {bufferId && !readOnly && (
          <button
            type="button"
            className={`cm-shuvix-fmcard-meta-regenerate ${LINK_BUTTON}`}
            title={t('notebook.frontmatter.metaRegenerateHint')}
            disabled={!!writes.pending}
            onClick={() => requestNewObjectId(sessionId, setObjectId)}
          >
            {t('notebook.frontmatter.metaRegenerate')}
          </button>
        )}
      </div>

      {view.fillKeys.map((key) => (
        <div key={key} className={`cm-shuvix-fmcard-meta-row ${ROW}`} data-key={key}>
          <span className={LABEL} title={labelOf(key)}>
            {labelOf(key)}
          </span>
          <div className="min-w-0 flex-1">
            {/* 与卡片字段槽位同一组排版类（-ml-2：无描边控件里的文字与只读值对齐）；钩子类名另起 ——
                `.cm-shuvix-fmcard-slot` 是卡片字段槽位的计数钩子，这里不占它 */}
            <div className="cm-shuvix-fmcard-meta-slot min-h-6 flex items-center -ml-2">
              <FrontmatterFieldPicker
                fieldKey={key}
                markerType={markerType}
                kind="select"
                value={valueOf(key)}
                onChange={(next) =>
                  requestMetaWrite({ sessionId, bufferId, key, value: next, setObjectId })
                }
              />
            </div>
            {view.declared.includes(key) && (
              <div className="cm-shuvix-fmcard-meta-declared text-[11px] leading-5 text-text-tertiary/80">
                {t('notebook.frontmatter.metaDeclared')}
              </div>
            )}
          </div>
        </div>
      ))}

      {writes.pending && (
        <div className="cm-shuvix-fmcard-meta-saving px-1 text-[11px] leading-5 text-text-tertiary/80">
          {t('notebook.frontmatter.metaSaving')}
        </div>
      )}
      {[...view.warnings, ...(writes.error ? [errorText(writes.error)] : [])].map((message) => (
        <div
          key={message}
          className="cm-shuvix-fmcard-meta-warning mx-1 mt-1 px-2.5 py-1.5 rounded-md text-[11px] leading-relaxed break-words bg-amber-500/10 text-amber-600 dark:text-amber-400"
        >
          {message}
        </div>
      ))}
    </div>
  )
}
