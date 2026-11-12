/**
 * GoalBar —— 目标栏（目标模式，docs/goal-mode-design.md §9.1，实验）。
 *
 * 会话有目标时，输入框卡片最顶上一格（裁决 D8：输入框上方、常驻，不随对话滚动 —— 它是一直有效的会话状态，上面有
 * 控制按钮；任务列表搬去对话末尾是因为它是一次运行的进度，目标栏不是）。形态与 QueuePanel 同源：自身无边框 / 圆角 /
 * 底色，只用一条 border-b 与下方分隔。
 *
 *  - 一行：状态记号 + 状态 · 第几轮 / 上限 · 时长（没有钱：ShuviX 不算花费），行尾是图标按钮（名字在悬停提示里）：
 *      进行中 → 暂停 / 编辑 / 清除；暂停中 → 继续（轮数、时长撞线的另给「调高上限并继续」）/ 编辑 / 清除；
 *      达成 / 做不到 → 沿用原文再设一次 / 移除。
 *  - 第二行：最近一次判定（结论 + 理由），点开看完整原文、建议的下一步、各项上限。
 *  - 目标检查被停用（没有 hook 订阅 `goal.check`）时明说：目标会在第一次判定时暂停（§4.2）。
 *  - 编辑是一张小表单（GoalEditor）：原文 ≤ 4000 字、续跑轮数上限（目标本来有时长上限时还有它）。输入框里只发
 *    `/goal` 也打开它（没有目标时是「设新目标」）。
 *
 * 所有操作走 `agent.goalAct`，被拒时就地显示宿主给的那句话。渠道端（Chrome 侧边栏）没有宿主 API：只读，不出按钮。
 * 桌面、手机、远程网页是同一个组件；触屏密度下图标按钮 40px 见方、单独一行靠右。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ChevronDown,
  ChevronsUp,
  ChevronUp,
  Loader2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
  X,
  type LucideIcon
} from 'lucide-react'
import {
  DEFAULT_GOAL_LIMITS,
  GOAL_OBJECTIVE_MAX_CHARS,
  type GoalAction,
  type GoalLimits,
  type GoalView
} from '@shuvix/chat-protocol/types/goal'
import { getHostApi } from '../../api/chatApi'
import { useChatStore, type GoalEditorMode, type GoalEditorState } from '../../stores/chatStore'
import { useChatDensity } from '../../host/chatHostContext'
import { ExperimentalTag } from '../common/ExperimentalTag'
import { GoalMark } from './GoalMark'
import { RedactedText } from './RedactedText'
import { formatGoalDuration, goalSummaryLine, parseGoalLimitFields } from './goalFormat'

/** 进行中时多久刷新一次时长（分钟粒度，半分钟一拍就够） */
const CLOCK_MS = 30_000

/** 设置里的缺省上限键（主进程 goalService 同名） */
const DEFAULT_TURNS_KEY = 'goal.defaultMaxTurns'

/** 发给宿主的一次目标操作；被拒 → 宿主那句话，抛错 → 错误原文 */
async function act(sessionId: string, action: GoalAction): Promise<string | null> {
  const goalAct = getHostApi()?.agent?.goalAct
  if (!goalAct) return null
  try {
    const result = await goalAct({ sessionId, action })
    return result.ok ? null : result.error
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** 进行中时按拍刷新的「现在」（时长用）；别的时候不走 */
function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => clearInterval(timer)
  }, [running])
  return now
}

export function GoalBar({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const touch = useChatDensity() === 'touch'
  const goal = useChatStore((s) => s.sessionGoals[sessionId] ?? null)
  const waitingAnswer = useChatStore((s) => (s.sessionPendingInputs[sessionId]?.length ?? 0) > 0)
  const editor = useChatStore((s) => (s.goalEditor?.sessionId === sessionId ? s.goalEditor : null))
  const canAct = !!getHostApi()?.agent?.goalAct
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const now = useClock(goal?.status === 'active')

  if (!goal && !editor) return null

  const run = async (action: GoalAction): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    const failure = await act(sessionId, action)
    setBusy(false)
    setError(failure)
  }
  const openEditor = (mode: GoalEditorMode): void => {
    setError(null)
    useChatStore.getState().openGoalEditor(sessionId, mode)
  }

  // 图标按钮：不抢状态行的眼（用户 2026-11-12：文字按钮太显眼）；名字放在 title / aria-label 里。
  // 「主」操作（暂停后的继续、调高并继续、再设一次）只用强调色的图标区分，不铺底色
  const button = (
    action: string,
    label: string,
    Icon: LucideIcon,
    onClick: () => void,
    primary = false
  ): React.JSX.Element => (
    <button
      key={action}
      type="button"
      data-goal-action={action}
      disabled={busy}
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex-shrink-0 inline-flex items-center justify-center rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        touch ? 'w-10 h-10' : 'w-6 h-6'
      } ${
        primary
          ? 'text-accent hover:bg-accent/10'
          : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      <Icon size={touch ? 18 : 14} />
    </button>
  )

  let actions: React.JSX.Element[] = []
  if (goal && canAct && !editor) {
    if (goal.status === 'active') {
      actions = [
        button('pause', t('goal.action.pause'), Pause, () => void run({ type: 'pause' })),
        button('edit', t('goal.action.edit'), Pencil, () => openEditor('edit')),
        button('clear', t('goal.action.clear'), Trash2, () => void run({ type: 'clear' }))
      ]
    } else if (goal.status === 'paused') {
      // 撞在上限上暂停的：宿主不让直接继续（上限还在越线），先调高再继续；直接点「继续」被拒时就地给那句话
      const atLimit = goal.pauseReason === 'turns' || goal.pauseReason === 'wall-clock'
      actions = [
        ...(atLimit
          ? [
              button(
                'raise',
                t('goal.action.raiseAndResume'),
                ChevronsUp,
                () => openEditor('raise'),
                true
              )
            ]
          : []),
        button(
          'resume',
          t('goal.action.resume'),
          Play,
          () => void run({ type: 'resume' }),
          !atLimit
        ),
        button('edit', t('goal.action.edit'), Pencil, () => openEditor('edit')),
        button('clear', t('goal.action.clear'), Trash2, () => void run({ type: 'clear' }))
      ]
    } else {
      actions = [
        button(
          'set-again',
          t('goal.action.setAgain'),
          RotateCcw,
          () => void run({ type: 'set', objective: goal.objective }),
          true
        ),
        button('dismiss', t('goal.action.dismiss'), X, () => void run({ type: 'clear' }))
      ]
    }
  }

  const verdict = goal?.lastVerdict
  const verdictLine = verdict
    ? t('goal.lastCheck', { verdict: t(`goal.verdict.${verdict.verdict}`), reason: verdict.reason })
    : null

  return (
    <div
      className="border-b border-border-secondary/40 px-3.5 py-1.5"
      data-goal-bar=""
      data-goal-status={goal?.status ?? 'new'}
    >
      {goal && (
        <>
          <div className={touch ? 'flex flex-col gap-1' : 'flex items-center gap-2'}>
            <button
              type="button"
              data-goal-toggle=""
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? t('goal.collapse') : t('goal.expand')}
              className={`flex-1 min-w-0 flex items-center gap-2 text-left text-text-tertiary hover:text-text-secondary transition-colors ${
                touch ? 'min-h-[40px] text-[13px]' : 'text-[11px]'
              }`}
            >
              <GoalMark status={goal.status} size={touch ? 16 : 13} />
              <span data-goal-state="" className="min-w-0 truncate text-text-primary">
                {goalSummaryLine(goal, { waitingAnswer, now }, t)}
              </span>
              {goal.judging && (
                <Loader2 size={11} className="flex-shrink-0 text-accent animate-spin" />
              )}
              <ExperimentalTag feature="goal" />
              <span className="flex-1" />
              {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
            </button>
            {actions.length > 0 && (
              <div
                className={`flex items-center ${touch ? 'justify-end gap-1 pb-1' : 'gap-0.5'}`}
                data-goal-actions=""
              >
                {actions}
              </div>
            )}
          </div>

          {/* 最近一次判定：折叠时一行（截断），展开后在下面的细节里给全文 */}
          {verdictLine && !expanded && (
            <div
              data-goal-verdict={verdict!.verdict}
              className={`truncate text-text-tertiary ${
                touch ? 'text-[12px] pl-6' : 'text-[11px] pl-[21px]'
              }`}
            >
              <RedactedText text={verdictLine} />
            </div>
          )}

          {goal.checkerMissing && (
            <div
              data-goal-checker-missing=""
              className={`mt-0.5 flex items-start gap-1.5 text-warning ${
                touch ? 'text-[12px]' : 'text-[11px]'
              }`}
            >
              <AlertTriangle size={12} className="mt-[1px] flex-shrink-0" />
              <span>{t('goal.checkerMissing')}</span>
            </div>
          )}

          {expanded && <GoalDetails goal={goal} touch={touch} />}
        </>
      )}

      {editor && (
        <GoalEditor
          key={editor.nonce}
          editor={editor}
          goal={goal}
          touch={touch}
          onDone={() => useChatStore.getState().closeGoalEditor()}
        />
      )}

      {error && (
        <div
          data-goal-error=""
          role="status"
          className={`mt-1 text-error break-words ${touch ? 'text-[12px]' : 'text-[11px]'}`}
        >
          {error}
        </div>
      )}
    </div>
  )
}

/** 展开：完整原文、最近一次判定的理由与建议、各项上限与用量 */
function GoalDetails({ goal, touch }: { goal: GoalView; touch: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const label = 'text-[11px] text-text-tertiary'
  const limits = [
    t('goal.limitTurns', { n: goal.limits.maxTurns }),
    t('goal.limitStall', { n: goal.limits.stallTurns }),
    ...(goal.limits.wallClockMin !== undefined
      ? [t('goal.limitTime', { time: formatGoalDuration(goal.limits.wallClockMin * 60_000, t) })]
      : [])
  ]
  return (
    <div
      data-goal-details=""
      className={`mt-1 mb-0.5 space-y-1.5 ${touch ? 'pl-6 text-[14px]' : 'pl-[21px] text-[12px]'}`}
    >
      <div>
        <div className={label}>{t('goal.objectiveLabel')}</div>
        <div
          data-goal-objective=""
          className="max-h-[30vh] overflow-y-auto thin-scrollbar whitespace-pre-wrap break-words text-text-primary"
        >
          <RedactedText text={goal.objective} />
        </div>
      </div>
      {goal.lastVerdict && (
        <div>
          <div className={label}>
            {t('goal.lastCheckLabel', { verdict: t(`goal.verdict.${goal.lastVerdict.verdict}`) })}
          </div>
          <div className="whitespace-pre-wrap break-words text-text-secondary">
            <RedactedText text={goal.lastVerdict.reason} />
          </div>
          {goal.lastVerdict.nextStep && (
            <div className="mt-0.5 whitespace-pre-wrap break-words text-text-secondary">
              {t('goal.nextStep')} <RedactedText text={goal.lastVerdict.nextStep} />
            </div>
          )}
        </div>
      )}
      <div className={label} data-goal-limits="">
        {limits.join(' · ')}
      </div>
    </div>
  )
}

/**
 * 表单的输入：原文、续跑轮数上限，以及时长上限（分钟，空 = 不限）——
 * 时长只在目标本来就有这一项时出现（`time: null` = 不出这一格、不改它）
 */
interface EditorFields {
  objective: string
  turns: string
  time: string | null
}

function fieldsOf(limits: GoalLimits, objective: string): EditorFields {
  return {
    objective,
    turns: String(limits.maxTurns),
    time: limits.wallClockMin !== undefined ? String(limits.wallClockMin) : null
  }
}

/**
 * 目标编辑器：设新目标 / 改原文与上限 / 调高上限并继续（先 `edit` 上限，再 `resume`）。保存成功即关；被拒就地显示
 * 宿主那句话、表单留着。设新目标时上限的初值取设置里的缺省（取不到用内置缺省）；没动过就不交，由宿主按设置定。
 * 已经结束（达成 / 做不到）的目标不能改，只能沿用原文再设 —— 目标栏上对它们不给「编辑」。
 */
function GoalEditor({
  editor,
  goal,
  touch,
  onDone
}: {
  editor: GoalEditorState
  goal: GoalView | null
  touch: boolean
  onDone: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // 「改」「调高」都要有一个还在进行或暂停的目标；没有（刚被清掉、已经结束）就按设新目标处理
  const mode: GoalEditorMode =
    editor.mode !== 'new' && goal && (goal.status === 'active' || goal.status === 'paused')
      ? editor.mode
      : 'new'
  const [fields, setFields] = useState<EditorFields>(() =>
    mode === 'new' ? fieldsOf(DEFAULT_GOAL_LIMITS, '') : fieldsOf(goal!.limits, goal!.objective)
  )
  const [limitsTouched, setLimitsTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 设新目标：上限的初值换成设置里的缺省（没动过才换）
  useEffect(() => {
    if (mode !== 'new') return
    const get = getHostApi()?.settings?.get
    if (!get) return
    let alive = true
    void get(DEFAULT_TURNS_KEY)
      .then((turns) => {
        if (!alive) return
        setFields((prev) => ({
          ...prev,
          ...(turns && Number.isInteger(Number(turns)) && Number(turns) > 0
            ? { turns: String(Number(turns)) }
            : {})
        }))
      })
      .catch(() => {
        /* 用内置缺省 */
      })
    return () => {
      alive = false
    }
  }, [mode])

  const objective = fields.objective.trim()
  const objectiveChanged = goal ? objective !== goal.objective : true
  const canSave = !busy && (mode === 'raise' || objective.length > 0)

  const save = async (): Promise<void> => {
    if (!canSave) return
    const parsed = parseGoalLimitFields(fields)
    if ('errorKey' in parsed) {
      setError(t(parsed.errorKey))
      return
    }
    setBusy(true)
    setError(null)
    const sid = editor.sessionId
    let failure: string | null
    if (mode === 'new') {
      failure = await act(sid, {
        type: 'set',
        objective,
        ...(limitsTouched ? { limits: parsed.limits } : {})
      })
    } else {
      failure = await act(sid, {
        type: 'edit',
        ...(mode === 'edit' && objectiveChanged ? { objective } : {}),
        limits: parsed.limits
      })
      if (failure === null && mode === 'raise') failure = await act(sid, { type: 'resume' })
    }
    setBusy(false)
    if (failure === null) onDone()
    else setError(failure)
  }

  const input = `bg-bg-primary rounded-md border border-border-secondary/50 text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/60 transition-colors ${
    touch ? 'px-3 py-2 text-[14px]' : 'px-2.5 py-1 text-[12px]'
  }`
  const fieldLabel = `flex flex-col gap-1 text-text-tertiary ${touch ? 'text-[12px]' : 'text-[11px]'}`
  const setLimit = (key: 'turns' | 'time', value: string): void => {
    setLimitsTouched(true)
    setFields((prev) => ({ ...prev, [key]: value }))
  }

  return (
    // noValidate：上限的校验由 save 自己做、就地给一句话（浏览器自带的气泡在手机上看不全，各端说法也不一）
    <form
      noValidate
      data-goal-editor={mode}
      className={`${goal ? 'mt-1.5' : ''} space-y-2`}
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      {!goal && (
        <div
          className={`flex items-center gap-2 text-text-primary ${touch ? 'text-[14px]' : 'text-[12px]'}`}
        >
          <GoalMark status="new" size={touch ? 16 : 13} />
          <span className="min-w-0 truncate">{t('goal.newTitle')}</span>
          <ExperimentalTag feature="goal" />
        </div>
      )}
      {mode === 'raise' ? (
        <div className={`text-text-secondary ${touch ? 'text-[13px]' : 'text-[11px]'}`}>
          {t('goal.raiseHint')}
        </div>
      ) : (
        <label className={fieldLabel}>
          <span className="flex items-center justify-between gap-2">
            <span>{t('goal.objectiveLabel')}</span>
            <span className="tabular-nums" data-goal-objective-count="">
              {fields.objective.length} / {GOAL_OBJECTIVE_MAX_CHARS}
            </span>
          </span>
          <textarea
            data-goal-objective-input=""
            autoFocus
            value={fields.objective}
            maxLength={GOAL_OBJECTIVE_MAX_CHARS}
            rows={touch ? 4 : 3}
            placeholder={t('goal.placeholder')}
            onChange={(e) => setFields((prev) => ({ ...prev, objective: e.target.value }))}
            onKeyDown={(e) => {
              // 回车换行；⌘ / Ctrl + 回车保存（同输入框接了实体键盘时的发送）
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void save()
              }
            }}
            className={`${input} w-full resize-y max-h-[30vh] thin-scrollbar`}
          />
        </label>
      )}
      <div className={`flex gap-3 ${touch ? 'flex-col' : 'items-end flex-wrap'}`}>
        <label className={fieldLabel}>
          <span>{t('goal.turnsLimitLabel')}</span>
          <input
            data-goal-turns-input=""
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={fields.turns}
            autoFocus={mode === 'raise'}
            onChange={(e) => setLimit('turns', e.target.value)}
            className={`${input} ${touch ? 'w-full' : 'w-24'}`}
          />
        </label>
        {fields.time !== null && (
          <label className={fieldLabel}>
            <span>{t('goal.timeLimitLabel')}</span>
            <input
              data-goal-time-input=""
              type="number"
              inputMode="numeric"
              min={1}
              step="any"
              value={fields.time}
              placeholder={t('goal.limitNone')}
              onChange={(e) => setLimit('time', e.target.value)}
              className={`${input} ${touch ? 'w-full' : 'w-24'}`}
            />
          </label>
        )}
        <span className="flex-1" />
        <div className={`flex items-center gap-2 ${touch ? 'justify-end' : ''}`}>
          <button
            type="button"
            data-goal-editor-cancel=""
            onClick={onDone}
            className={`rounded-lg text-text-secondary hover:bg-bg-hover transition-colors ${
              touch ? 'min-h-[40px] px-3.5 text-[13px]' : 'px-2.5 py-1 text-[11px]'
            }`}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            data-goal-editor-save=""
            disabled={!canSave}
            className={`rounded-lg transition-colors ${
              touch ? 'min-h-[40px] px-3.5 text-[13px]' : 'px-2.5 py-1 text-[11px]'
            } ${
              canSave
                ? 'bg-accent text-white hover:bg-accent-hover'
                : 'bg-bg-hover text-text-tertiary cursor-not-allowed'
            }`}
          >
            {mode === 'new'
              ? t('goal.setGoal')
              : mode === 'raise'
                ? t('goal.saveAndResume')
                : t('goal.save')}
          </button>
        </div>
      </div>
      {error && (
        <div
          data-goal-editor-error=""
          role="status"
          className={`text-error break-words ${touch ? 'text-[12px]' : 'text-[11px]'}`}
        >
          {error}
        </div>
      )}
    </form>
  )
}
