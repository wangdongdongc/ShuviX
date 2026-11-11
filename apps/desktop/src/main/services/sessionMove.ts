/**
 * 把别的项目的会话搬进调用方所在的项目 —— `session` 工具 `move-session` 的语义（docs/project-split-design.md §4）。
 *
 * 只能往自己这里拉：目标项目恒是调用方所在的项目，没有「搬到别处」，也搬不了自己。分两步，中间隔着确认卡：
 *   plan  —— 落定调用方的项目，逐条判定能不能搬。都在出卡之前做，不满足的把原因回给模型；
 *   apply —— 用户点头之后再判一遍（等卡片的工夫里那条会话可能开始跑、被删、被别处搬走），然后改库。
 *
 * 搬的是整棵树：根会话和它的子会话一起改 `projectId`（子会话的工作目录读的是它自己那一行，不级联就留在旧项目的
 * 目录里干活）。fork 是独立的会话，不跟着走。
 *
 * 搬完之后绝大多数东西自己跟上：工作目录、环境变量每次工具调用现查（toolContext `resolveProjectConfig`），权限表
 * 下一次读表时对账（services/acl），项目库按会话此刻的项目现解析（knowledge/sessionBundle）。这里要动手的只有两样：
 *   - 笔记本会话的 `notebookPath` 相对旧项目根，按新根重算（文件本身不动）；
 *   - 两个项目目录不同时重建冻结的系统提示词（裁决 D4）：人设里冻结着旧目录，不重建模型会去错的地方找文件。
 *     目录相同就不动 —— 项目提示词、项目库不同时已有的过时提醒会出现，重建由用户决定（那会丢提示词缓存）。
 */
import { isAbsolute, relative, resolve, sep } from 'path'
import { isBotSessionSettings, workProjectOf } from '@shuvix/chat-protocol/botSession'
import { isChromeTabSessionSettings } from '@shuvix/chat-protocol/chromeTabSession'
import { isHiddenProjectId } from '@shuvix/chat-protocol/hiddenProjects'
import { projectDao } from '../dao/projectDao'
import { createLogger } from '../logger'
import {
  broadcastSessionConfigChanged,
  broadcastSessionListChanged
} from '../utils/sessionConfigBroadcast'
import { sessionRecords } from './sessionRecords'
import { sessionService } from './sessionService'
import { sessionRunStatus } from './subSessionRunner'

const log = createLogger('SessionMove')

/** 一次调用最多点名多少条：再多，确认卡就不是人能看完的了 */
export const SESSION_MOVE_MAX = 50

export interface MoveProject {
  id: string
  name: string
  path: string
}

/** 能搬的一条（根会话） */
export interface MoveCandidate {
  id: string
  title: string
  /** 它现在所在的项目（项目行读不到时名字与目录是空串） */
  fromProject: MoveProject
  /** 跟着走的子会话 */
  children: string[]
}

/** 搬不了的一条；`reason` 是给模型看的一句话 */
export interface MoveRefusal {
  id: string
  title?: string
  reason: string
}

export interface SessionMovePlan {
  /** 搬进去的项目：调用方所在的那个 */
  project: MoveProject
  candidates: MoveCandidate[]
  /** 本来就在这个项目里的 */
  already: Array<{ id: string; title: string }>
  refused: MoveRefusal[]
}

export interface MovedSession {
  id: string
  title: string
  fromProject: string
  subSessions: number
  /** 两个项目目录不同：这棵树从此在新目录里工作 */
  directoryChanged: boolean
  /** 目录变了、却没能重建系统提示词的会话数（重建那一刻它正忙） */
  promptNotRebuilt: number
}

export interface SessionMoveOutcome {
  project: MoveProject
  moved: MovedSession[]
  already: Array<{ id: string; title: string }>
  refused: MoveRefusal[]
}

const NOT_ATTACHED =
  'This task is not attached to a session — the session tool is unavailable here.'
const NO_DESTINATION =
  'This session does not belong to a project, so there is no project to move sessions into, and this session cannot be put into one. Sessions are moved from inside the destination project: tell the user to open a session in that project, @-mention the sessions there and ask again.'

type Judged =
  | { kind: 'candidate'; candidate: MoveCandidate }
  | { kind: 'already'; id: string; title: string }
  | { kind: 'refused'; refusal: MoveRefusal }

const refused = (id: string, title: string | undefined, reason: string): Judged => ({
  kind: 'refused',
  refusal: title === undefined ? { id, reason } : { id, title, reason }
})

/** 调用方所在的项目；不在项目里（临时对话、bot 会话、标签页会话、ShuviX 文件的笔记本）→ null */
function destinationOf(callerId: string): MoveProject | null | undefined {
  const caller = sessionRecords.pick(callerId, ['projectId', 'settings'])
  if (!caller) return undefined
  if (!caller.projectId || isHiddenProjectId(caller.projectId)) return null
  if (isChromeTabSessionSettings(caller.settings)) return null
  const project = projectDao.pick(caller.projectId, ['id', 'name', 'path'])
  return project ? { id: project.id, name: project.name, path: project.path } : null
}

function samePath(a: string, b: string): boolean {
  return !!a && !!b && resolve(a) === resolve(b)
}

/**
 * 笔记本会话的 `notebookPath` 换一个项目根：文件不动，路径照新根重写 —— 在新根之内是相对路径（forward-slash），
 * 之外是绝对路径（这个字段本来就收项目外的绝对路径）。旧根读不到时相对路径无从解析，原样留着。
 */
export function rebaseNotebookPath(notebookPath: string, fromRoot: string, toRoot: string): string {
  if (!isAbsolute(notebookPath) && !fromRoot) return notebookPath
  const absolute = isAbsolute(notebookPath) ? notebookPath : resolve(fromRoot, notebookPath)
  const rel = relative(resolve(toRoot), absolute)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/')
  return absolute
}

/** 一条会话此刻能不能搬进 `project`（plan 与 apply 用的是同一份判定） */
function judge(id: string, callerId: string, project: MoveProject): Judged {
  if (id === callerId) return refused(id, undefined, 'That is this session itself.')
  const row = sessionRecords.pick(id, ['title', 'projectId', 'parentId', 'settings'])
  if (!row) {
    return refused(
      id,
      undefined,
      "No session has this id. Use the exact id from the user's mention; never guess one."
    )
  }
  const { title } = row
  if (row.parentId) {
    const parent = sessionRecords.pick(row.parentId, ['title'])
    return refused(
      id,
      title,
      `It is a sub-session of "${parent?.title ?? ''}" (${row.parentId}). Move that session and this one comes along.`
    )
  }
  if (isBotSessionSettings(row.settings) || workProjectOf(row.settings)) {
    return refused(id, title, 'It belongs to a bot; a bot session stays with its bot.')
  }
  if (sessionRecords.isEphemeral(id) || isChromeTabSessionSettings(row.settings)) {
    return refused(id, title, 'It is a temporary session that is not kept in any project.')
  }
  if (!row.projectId) {
    return refused(
      id,
      title,
      'It does not belong to a project; only a session of another project can be moved.'
    )
  }
  if (isHiddenProjectId(row.projectId)) {
    return refused(
      id,
      title,
      'It is the notebook of a file ShuviX manages (a knowledge entry, daily report, tracked item, agent, bot, policy, hook or skill), not a project session.'
    )
  }
  if (row.projectId === project.id) return { kind: 'already', id, title }

  const children = sessionRecords.findChildren(id).map((child) => child.id)
  // 工作目录是每次工具调用现查的：一轮当中换了项目，后面的命令会不声不响换目录
  if (sessionRunStatus(id) !== 'idle') {
    return refused(
      id,
      title,
      `It is in the middle of a turn (status: ${sessionRunStatus(id)}). Move it once that turn has ended.`
    )
  }
  if (children.some((child) => sessionRunStatus(child) !== 'idle')) {
    return refused(
      id,
      title,
      'One of its sub-sessions is in the middle of a turn. Move it once that turn has ended.'
    )
  }

  const from = projectDao.pick(row.projectId, ['id', 'name', 'path'])
  const fromProject: MoveProject = {
    id: row.projectId,
    name: from?.name ?? '',
    path: from?.path ?? ''
  }
  // 一个文件至多一个笔记本会话：本项目里已经有这份文件的笔记本，再搬一条进来就成了两条
  const notebookPath = row.settings?.notebookPath
  if (notebookPath) {
    const rebased = rebaseNotebookPath(notebookPath, fromProject.path, project.path)
    if (sessionRecords.findByProjectAndNotebookPath(project.id, rebased)) {
      return refused(
        id,
        title,
        'It is the notebook of a file that already has a notebook session in this project.'
      )
    }
  }
  return { kind: 'candidate', candidate: { id, title, fromProject, children } }
}

/**
 * 第一步：落定目标项目，逐条判定。`{ error }` = 这次调用整个不成立（调用方不在项目里、一条都没点名、点得太多），
 * 文案给模型。
 */
export function planSessionMove(
  callerId: string,
  rawIds: readonly string[]
): SessionMovePlan | { error: string } {
  const project = destinationOf(callerId)
  if (project === undefined) return { error: NOT_ATTACHED }
  if (project === null) return { error: NO_DESTINATION }
  const ids = [...new Set(rawIds.map((id) => id.trim()).filter(Boolean))]
  if (ids.length === 0) {
    return {
      error:
        'Pass the ids of the sessions to move in `session_ids`, each exactly as the user gave it.'
    }
  }
  if (ids.length > SESSION_MOVE_MAX) {
    return {
      error: `That is ${ids.length} sessions; one call moves at most ${SESSION_MOVE_MAX}. Split them over several calls.`
    }
  }
  const plan: SessionMovePlan = { project, candidates: [], already: [], refused: [] }
  for (const id of ids) {
    const judged = judge(id, callerId, project)
    if (judged.kind === 'candidate') plan.candidates.push(judged.candidate)
    else if (judged.kind === 'already') plan.already.push({ id: judged.id, title: judged.title })
    else plan.refused.push(judged.refusal)
  }
  return plan
}

/** 搬一棵树：改归属 → 笔记本路径 → 目录变了就重建系统提示词 */
async function moveTree(candidate: MoveCandidate, project: MoveProject): Promise<MovedSession> {
  const ids = [candidate.id, ...candidate.children]
  const directoryChanged = !samePath(candidate.fromProject.path, project.path)
  const notebookPath = sessionRecords.pickSettings(candidate.id, ['notebookPath'])?.notebookPath
  for (const id of ids) sessionRecords.updateProjectId(id, project.id)
  if (notebookPath) {
    const rebased = rebaseNotebookPath(notebookPath, candidate.fromProject.path, project.path)
    if (rebased !== notebookPath) {
      sessionRecords.updateSettings(candidate.id, { notebookPath: rebased })
    }
  }
  let promptNotRebuilt = 0
  if (directoryChanged) {
    for (const id of ids) {
      try {
        const result = await sessionService.rebuildSystemPrompt(id)
        if (!result.success) promptNotRebuilt += 1
      } catch (err) {
        promptNotRebuilt += 1
        log.warn(`rebuild system prompt failed session=${id}: ${(err as Error).message}`)
      }
    }
  }
  // 归属换了，这条会话的配置面板（项目、权限表、知识库）读到的东西都变了
  for (const id of ids) broadcastSessionConfigChanged(id)
  log.info(
    `moved session=${candidate.id} (+${candidate.children.length} sub-sessions) ` +
      `project ${candidate.fromProject.id} -> ${project.id} directoryChanged=${directoryChanged}`
  )
  return {
    id: candidate.id,
    title: candidate.title,
    fromProject: candidate.fromProject.name,
    subSessions: candidate.children.length,
    directoryChanged,
    promptNotRebuilt
  }
}

/**
 * 第二步（用户已经在卡上点头）：每条再判一遍，过得了的才搬。会话列表的变更广播整批只发一次。
 */
export async function applySessionMove(
  callerId: string,
  plan: SessionMovePlan
): Promise<SessionMoveOutcome> {
  const outcome: SessionMoveOutcome = {
    project: plan.project,
    moved: [],
    already: [...plan.already],
    refused: [...plan.refused]
  }
  for (const planned of plan.candidates) {
    const judged = judge(planned.id, callerId, plan.project)
    if (judged.kind === 'refused') outcome.refused.push(judged.refusal)
    else if (judged.kind === 'already') {
      outcome.already.push({ id: judged.id, title: judged.title })
    } else outcome.moved.push(await moveTree(judged.candidate, plan.project))
  }
  if (outcome.moved.length > 0) broadcastSessionListChanged()
  return outcome
}
