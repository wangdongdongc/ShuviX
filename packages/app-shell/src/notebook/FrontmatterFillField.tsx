/**
 * 属性卡里**能由 ShuviX 补缺**的字段行（md 扩展元数据，chat-protocol mdMeta.ts）—— 目前是 agent 的模型与
 * 思考档位（MD_FM_FILL_KEYS）。它就挂在卡片原本那一行的槽位里，不另开一处：
 *
 *   - **随包发布的内置档案**（编辑器只读）：文件改不了，这一行改的是 ShuviX 里存的补缺值（经 metaWriteQueue
 *     写入；内置文件自带 `agent:builtin:<name>` 的 id）。文件里已经写了这个键 → md 优先，这一行照旧只读；
 *   - **用户自己的文件**：照旧改文件。文件里没写、ShuviX 里却存着补缺值时，把它显示出来并标明来源 ——
 *     它在生效，不能藏着；一改就写进文件，文件里的值从此优先。
 *
 * 值来自 ShuviX 时，值的文字换成强调色 + 点状下划线（`sourced`，只做样式上的区别、不挂文字标签），
 * 来源说明放在这一行的悬停提示里。卡片是纯 DOM 的 CM6 widget，本组件由
 * LivePreviewEditor 挂进字段槽位（独立 React root），YAML 一变整个重挂。
 */
import { useTranslation } from 'react-i18next'
import { FrontmatterFieldPicker } from './FrontmatterFieldPicker'
import { requestMetaWrite } from './metaWriteQueue'
import { useMdMetaView } from './useMdMetaView'

export interface FrontmatterFillFieldProps {
  /** 这份文件的笔记本会话 —— 主进程按它认文件 */
  sessionId: string
  fieldKey: string
  markerType: string
  /** 文件里这一行的原始值；键不存在或留空为 '' */
  fileValue: string
  /** 编辑器只读（内置档案）：改的是 ShuviX 里的补缺值，而不是文件 */
  readOnly: boolean
  /** 写回文件（null = 删掉这一行）—— 可编辑的文件走它 */
  onFileChange: (next: string | null) => void
}

/** 补缺值 → 选择器要的单行原始值；非字符串值原样字符串化 */
function controlValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function FrontmatterFillField({
  sessionId,
  fieldKey,
  markerType,
  fileValue,
  readOnly,
  onFileChange
}: FrontmatterFillFieldProps): React.JSX.Element {
  const { t } = useTranslation()
  const { view, writes, stale } = useMdMetaView(sessionId)
  const declared = fileValue.trim() !== ''

  // ShuviX 里这个键当前的值：在途的优先，其次刚写进去、重查还没回来的，最后是数据库里存的
  const fillValue = ((): string => {
    if (writes.pending?.has(fieldKey)) return writes.pending.get(fieldKey) ?? ''
    if (stale && writes.written.has(fieldKey)) return writes.written.get(fieldKey) ?? ''
    return controlValue(view?.fill[fieldKey])
  })()
  // 只读的内置文件、文件没写这个键、而且它有对象 id：这一行改的是 ShuviX 里的补缺值
  const metaBacked = readOnly && !declared && !!view?.objectId
  const shownFromMeta = !declared && fillValue !== '' && (metaBacked || !readOnly)
  const value = declared ? fileValue : shownFromMeta || metaBacked ? fillValue : fileValue

  const writeFill = (next: string | null): void => {
    if (!view?.objectId) return
    requestMetaWrite({
      sessionId,
      bufferId: view.objectId,
      key: fieldKey,
      value: next,
      // 这里只在文件已经带着 id 时写（内置自带；用户文件存过补缺值就必然有）—— 不会走到分配 id 那一步
      setObjectId: () => false
    })
  }

  const onChange = (next: string | null): void => {
    if (!readOnly) {
      // 用户文件：选值写进文件。正显示着 ShuviX 里的补缺值时选「未设置」，清掉的是那个补缺值 ——
      // 文件里本来就没有这一行，写文件清不掉它
      if (next === null && shownFromMeta) writeFill(null)
      else onFileChange(next)
      return
    }
    if (metaBacked) writeFill(next)
  }
  // 解析器不收这份补缺值（主进程的 warnings）：值照样显示，但标明它没生效
  const notApplied = shownFromMeta && (view?.warnings.length ?? 0) > 0

  return (
    <span
      className="cm-shuvix-fmcard-fill flex items-center gap-1.5 min-w-0"
      data-key={fieldKey}
      data-source={shownFromMeta ? 'shuvix' : undefined}
      title={metaBacked || shownFromMeta ? t('notebook.frontmatter.fillTagHint') : undefined}
    >
      <FrontmatterFieldPicker
        fieldKey={fieldKey}
        markerType={markerType}
        kind="select"
        value={value}
        onChange={onChange}
        readOnly={readOnly && !metaBacked}
        sourced={shownFromMeta}
      />
      {notApplied && (
        <span
          className="cm-shuvix-fmcard-fill-warning shrink-0 text-[11px] text-amber-600 dark:text-amber-400"
          title={view?.warnings.join('\n')}
        >
          {t('notebook.frontmatter.fillNotApplied')}
        </span>
      )}
      {(metaBacked || shownFromMeta) && writes.error && (
        <span
          className="cm-shuvix-fmcard-fill-error shrink-0 text-[11px] text-amber-600 dark:text-amber-400"
          title={
            writes.error.kind === 'rejected'
              ? (writes.error.message ?? writes.error.reason)
              : undefined
          }
        >
          {t('notebook.frontmatter.fillSaveFailed')}
        </span>
      )}
    </span>
  )
}
