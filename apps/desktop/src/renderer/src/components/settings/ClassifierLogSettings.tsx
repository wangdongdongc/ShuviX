/**
 * 分类器日志（监视器 tab 的子页）—— 每次调用分类模型一行，审计用。与场景无关：今天只有命令风险分类
 * （scene `command-risk`），以后的分类场景照样落在这一页，按场景筛选即可。
 *
 * 版式同 LLM 请求日志：单列流 + 就地展开（同时只展开一条）。展开后按题型**通用地**渲染题目与答案 ——
 * 单选题列出每个选项的说明与概率、高亮选中项；是非题给出两种答案的说明与概率；打分题列出各档与得分 ——
 * 再给出发给分类器的内容（state）与原始答案，所以新场景不需要任何专用界面。
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { Trash2, RefreshCw, ScanSearch, ChevronRight, ChevronDown, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { SessionPicker } from '../common/SessionPicker'
import { ZenSelect } from '../common/ZenSelect'

/** 列表查询上限 */
const LOG_LIST_LIMIT = 200

const STATUSES = ['ok', 'incomplete', 'failed', 'timeout', 'aborted', 'misconfigured'] as const

interface LogSummary {
  id: string
  createdAt: number
  scene: string
  sessionId: string
  sessionTitle: string
  toolCallId: string
  subject: string
  provider: string
  model: string
  response: string
  status: string
  error: string
  ms: number
  inputTokens: number
  cost: number
}

interface LogDetail extends Omit<LogSummary, 'sessionTitle'> {
  request: string
}

/** pi 的题目与答案（只取渲染要用的形状；解析不了的按原文显示） */
type Question =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'bool'; instructions: string; criteria: { true: string; false: string } }
type Answer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; confidence: number }
  | { type: 'bool'; probability: number }

function parseJson<T>(text: string): T | null {
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

const pct = (p: number): string => `${Math.round(p * 100)}%`

/** 一行答案的简短摘要（列表里用）：单选给选中项 + 概率，是非给概率，打分给分数 */
function answerSummary(response: string): string {
  const answers = parseJson<Record<string, Answer>>(response)
  if (!answers) return ''
  return Object.entries(answers)
    .map(([key, answer]) => {
      if (answer.type === 'choice') return `${answer.choice} ${pct(answer.confidence)}`
      if (answer.type === 'bool') return `${key} ${pct(answer.probability)}`
      if (answer.type === 'score') return `${key} ${answer.score.toFixed(1)}`
      return key
    })
    .join(' · ')
}

export function ClassifierLogSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<LogSummary[]>([])
  const [scenes, setScenes] = useState<string[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<LogDetail | null>(null)
  const [loadingList, setLoadingList] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [filterSessionId, setFilterSessionId] = useState('')
  const [filterScene, setFilterScene] = useState('')
  const [filterStatus, setFilterStatus] = useState('')

  const sceneLabel = useCallback(
    (scene: string) => t(`settings.classifierLog.scenes.${scene}`, { defaultValue: scene }),
    [t]
  )
  const statusLabel = useCallback(
    (status: string) => t(`settings.classifierLog.status.${status}`, { defaultValue: status }),
    [t]
  )

  const filters = useMemo(
    () => ({
      sessionId: filterSessionId || undefined,
      scene: filterScene || undefined,
      status: filterStatus || undefined
    }),
    [filterSessionId, filterScene, filterStatus]
  )

  const loadLogs = useCallback(
    async (f: { sessionId?: string; scene?: string; status?: string }): Promise<void> => {
      setLoadingList(true)
      try {
        const [rows, sceneList] = await Promise.all([
          window.api.classifierLog.list({
            limit: LOG_LIST_LIMIT,
            ...(f.sessionId ? { sessionId: f.sessionId } : {}),
            ...(f.scene ? { scene: f.scene } : {}),
            ...(f.status ? { status: f.status } : {})
          }),
          window.api.classifierLog.scenes()
        ])
        setLogs(rows)
        setScenes(sceneList)
        setExpandedId((prev) => (prev && rows.some((row) => row.id === prev) ? prev : null))
      } finally {
        setLoadingList(false)
      }
    },
    []
  )

  const toggleRow = async (id: string): Promise<void> => {
    if (expandedId === id) {
      setExpandedId(null)
      setDetail(null)
      return
    }
    setExpandedId(id)
    setDetail(null)
    setLoadingDetail(true)
    try {
      setDetail((await window.api.classifierLog.get(id)) ?? null)
    } finally {
      setLoadingDetail(false)
    }
  }

  const handleClearConfirm = async (): Promise<void> => {
    setShowClearConfirm(false)
    await window.api.classifierLog.clear()
    setLogs([])
    setScenes([])
    setExpandedId(null)
    setDetail(null)
  }

  useEffect(() => {
    void loadLogs(filters)
  }, [loadLogs, filters])

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        data-classifier-log-toolbar
        className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-secondary"
      >
        <div className="flex-1 min-w-0 max-w-[140px]">
          <SessionPicker value={filterSessionId} onChange={setFilterSessionId} />
        </div>
        <div className="flex-1 min-w-0 max-w-[130px]">
          <ZenSelect
            value={filterScene}
            onChange={setFilterScene}
            placeholder={t('settings.classifierLog.allScenes')}
            options={scenes.map((scene) => ({ value: scene, label: sceneLabel(scene) }))}
          />
        </div>
        <div className="flex-1 min-w-0 max-w-[110px]">
          <ZenSelect
            value={filterStatus}
            onChange={setFilterStatus}
            placeholder={t('settings.classifierLog.allStatuses')}
            options={STATUSES.map((status) => ({ value: status, label: statusLabel(status) }))}
          />
        </div>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => void loadLogs(filters)}
            disabled={loadingList}
            title={t('common.refresh')}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw size={12} className={loadingList ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setShowClearConfirm(true)}
            disabled={logs.length === 0}
            title={t('common.clear')}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-text-tertiary hover:text-error hover:bg-error/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      <div
        data-classifier-log-hint
        className="flex-shrink-0 px-3 py-1.5 border-b border-border-secondary/50 text-[10px] leading-relaxed text-text-tertiary"
      >
        {t('settings.classifierLog.hint', { max: 5000 })}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loadingList && logs.length === 0 ? (
          <EmptyState text={t('settings.loadingLog')} />
        ) : logs.length === 0 ? (
          <EmptyState text={t('settings.classifierLog.empty')} />
        ) : (
          <>
            {logs.map((log) => {
              const open = expandedId === log.id
              const failed = log.status !== 'ok'
              return (
                <div
                  key={log.id}
                  data-classifier-log-id={log.id}
                  data-status={log.status}
                  className="border-b border-border-secondary/30"
                >
                  <button
                    onClick={() => void toggleRow(log.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-[11px] text-left transition-colors ${
                      open
                        ? 'sticky top-0 z-10 bg-bg-secondary text-text-primary'
                        : 'hover:bg-bg-hover/40'
                    }`}
                  >
                    {open ? (
                      <ChevronDown size={12} className="shrink-0 text-text-secondary" />
                    ) : (
                      <ChevronRight size={12} className="shrink-0 text-text-tertiary" />
                    )}
                    <span className="shrink-0 tabular-nums text-text-primary">
                      {formatTime(log.createdAt)}
                    </span>
                    <span className="shrink-0 px-1.5 py-px rounded bg-bg-tertiary text-[10px] text-text-secondary">
                      {sceneLabel(log.scene)}
                    </span>
                    <span className="flex-1 min-w-0 truncate font-mono text-text-secondary">
                      {log.subject}
                    </span>
                    <span
                      data-classifier-log-result
                      className={`shrink-0 max-w-[180px] truncate ${failed ? 'text-amber-500' : 'text-text-primary'}`}
                    >
                      {failed ? statusLabel(log.status) : answerSummary(log.response)}
                    </span>
                    <span className="shrink-0 w-[52px] text-right tabular-nums text-text-tertiary">
                      {log.ms} ms
                    </span>
                  </button>

                  {open && (
                    <div className="px-3 pb-5 pt-2 bg-bg-tertiary/10">
                      {loadingDetail && !detail ? (
                        <div className="flex items-center gap-2 py-6 justify-center text-text-tertiary">
                          <Loader2 size={14} className="animate-spin" />
                          <span className="text-[11px]">{t('settings.loadingLog')}</span>
                        </div>
                      ) : !detail ? (
                        <div className="py-6 text-center text-[11px] text-text-tertiary">
                          {t('settings.logNotFound')}
                        </div>
                      ) : (
                        <ClassifierLogDetail
                          detail={detail}
                          sessionTitle={log.sessionTitle}
                          statusLabel={statusLabel}
                        />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            <div className="px-3 py-2 text-center text-[10px] text-text-tertiary tabular-nums">
              {t('settings.httpLogLimitHint', { shown: logs.length, limit: LOG_LIST_LIMIT })}
            </div>
          </>
        )}
      </div>

      {showClearConfirm && (
        <ConfirmDialog
          title={t('settings.classifierLog.clearConfirm')}
          confirmText={t('common.clear')}
          cancelText={t('common.cancel')}
          onConfirm={handleClearConfirm}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────
// 详情：元信息 + 题目与答案（按题型通用渲染）+ 发送内容 + 原始答案
// ────────────────────────────────────────────────────────────────

function ClassifierLogDetail({
  detail,
  sessionTitle,
  statusLabel
}: {
  detail: LogDetail
  sessionTitle: string
  statusLabel: (status: string) => string
}): React.JSX.Element {
  const { t } = useTranslation()
  const request = parseJson<{ state?: unknown; questions?: Record<string, Question> }>(
    detail.request
  )
  const answers = parseJson<Record<string, Answer>>(detail.response) ?? {}
  const questions = request?.questions ?? {}

  return (
    <div className="space-y-3 text-[11px]">
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-[10px] text-text-tertiary">
        <span>
          {t('settings.classifierLog.model')}{' '}
          <span className="font-mono text-text-secondary">
            {detail.provider}/{detail.model}
          </span>
        </span>
        <span className="tabular-nums">
          {t('settings.classifierLog.duration')} {detail.ms} ms
        </span>
        {detail.inputTokens > 0 && (
          <span className="tabular-nums">↑ {detail.inputTokens.toLocaleString()} tk</span>
        )}
        <span>
          {t('settings.classifierLog.session')}{' '}
          <span className="text-text-secondary">
            {sessionTitle?.trim() || (detail.sessionId ? detail.sessionId : '—')}
          </span>
        </span>
        {detail.toolCallId && (
          <span className="font-mono">
            {t('settings.classifierLog.toolCall')} {detail.toolCallId}
          </span>
        )}
        <span
          data-classifier-log-status
          className={detail.status === 'ok' ? 'text-emerald-500' : 'text-amber-500'}
        >
          {statusLabel(detail.status)}
        </span>
      </div>

      {detail.error && (
        <div className="px-2 py-1.5 rounded border border-amber-500/30 bg-amber-500/5 text-amber-500 leading-relaxed">
          {detail.error}
        </div>
      )}

      <Section title={t('settings.classifierLog.subject')}>
        <pre className="whitespace-pre-wrap break-all font-mono text-text-primary">
          {detail.subject}
        </pre>
      </Section>

      <Section title={t('settings.classifierLog.questions')}>
        <div className="space-y-3">
          {Object.entries(questions).map(([key, question]) => (
            <QuestionView key={key} name={key} question={question} answer={answers[key]} />
          ))}
          {Object.keys(questions).length === 0 && <span className="text-text-tertiary">—</span>}
        </div>
      </Section>

      <Section title={t('settings.classifierLog.sent')}>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-text-secondary">
          {request ? JSON.stringify(request.state, null, 2) : detail.request || '—'}
        </pre>
      </Section>

      {detail.response && (
        <Section title={t('settings.classifierLog.rawAnswers')}>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-text-secondary">
            {JSON.stringify(answers, null, 2)}
          </pre>
        </Section>
      )}
    </div>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-text-tertiary">{title}</div>
      {children}
    </div>
  )
}

/** 一道题 + 它的答案：单选 / 打分 / 是非各一种画法，认不出的题型按原文显示 */
function QuestionView({
  name,
  question,
  answer
}: {
  name: string
  question: Question
  answer: Answer | undefined
}): React.JSX.Element {
  const header = (
    <div className="mb-1">
      <span className="font-mono text-text-secondary">{name}</span>
      <span className="ml-1.5 text-[10px] text-text-tertiary">{question.type}</span>
      <div className="text-text-primary leading-relaxed">{question.instructions}</div>
    </div>
  )

  if (question.type === 'choice') {
    const probs = answer?.type === 'choice' ? answer.probabilities : {}
    const chosen = answer?.type === 'choice' ? answer.choice : undefined
    return (
      <div data-classifier-question={name}>
        {header}
        <div className="space-y-0.5">
          {Object.entries(question.criteria).map(([option, description]) => (
            <OptionRow
              key={option}
              label={option}
              description={description}
              probability={probs[option]}
              chosen={option === chosen}
            />
          ))}
        </div>
      </div>
    )
  }
  if (question.type === 'bool') {
    const p = answer?.type === 'bool' ? answer.probability : undefined
    return (
      <div data-classifier-question={name}>
        {header}
        <div className="space-y-0.5">
          <OptionRow
            label="true"
            description={question.criteria.true}
            probability={p}
            chosen={p !== undefined && p >= 0.5}
          />
          <OptionRow
            label="false"
            description={question.criteria.false}
            probability={p === undefined ? undefined : 1 - p}
            chosen={p !== undefined && p < 0.5}
          />
        </div>
      </div>
    )
  }
  if (question.type === 'score') {
    const score = answer?.type === 'score' ? answer.score : undefined
    const level = score === undefined ? -1 : Math.round(score)
    return (
      <div data-classifier-question={name}>
        {header}
        <div className="space-y-0.5">
          {question.criteria.map((description, index) => (
            <OptionRow
              key={index}
              label={String(index)}
              description={description}
              chosen={index === level}
            />
          ))}
        </div>
        {answer?.type === 'score' && (
          <div className="mt-1 text-[10px] text-text-tertiary tabular-nums">
            score {answer.score.toFixed(2)} · confidence {pct(answer.confidence)}
          </div>
        )}
      </div>
    )
  }
  return (
    <div data-classifier-question={name}>
      <pre className="whitespace-pre-wrap break-all font-mono text-[10px] text-text-secondary">
        {JSON.stringify({ question, answer }, null, 2)}
      </pre>
    </div>
  )
}

function OptionRow({
  label,
  description,
  probability,
  chosen
}: {
  label: string
  description: string
  probability?: number
  chosen: boolean
}): React.JSX.Element {
  return (
    <div
      data-classifier-option={label}
      data-chosen={chosen ? 'true' : undefined}
      className={`grid grid-cols-[minmax(0,9rem)_3rem_minmax(0,1fr)] items-start gap-2 px-1.5 py-0.5 rounded ${
        chosen ? 'bg-accent/10 text-text-primary' : 'text-text-secondary'
      }`}
    >
      <span className={`font-mono truncate ${chosen ? 'text-accent' : ''}`}>{label}</span>
      <span className="relative h-3 mt-0.5 rounded-sm bg-bg-tertiary overflow-hidden">
        {probability !== undefined && (
          <span
            className={`absolute inset-y-0 left-0 ${chosen ? 'bg-accent' : 'bg-text-tertiary/50'}`}
            style={{ width: `${Math.round(probability * 100)}%` }}
          />
        )}
      </span>
      <span className="leading-relaxed">
        {probability !== undefined && (
          <span className="mr-1.5 tabular-nums text-text-tertiary">{pct(probability)}</span>
        )}
        {description}
      </span>
    </div>
  )
}

function EmptyState({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-text-tertiary px-6">
      <ScanSearch size={28} className="opacity-40" />
      <span className="text-[11px] text-center">{text}</span>
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
