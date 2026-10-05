/**
 * 崩在请求中途（P2-09，`crashMidRequest` 的变体）：进程 1 给会话建 agent、（可选）先跑几轮、再发一条
 * 挂住不答的输入（可带 requestId / driven），（可选）在它后面排一条 follow-up，然后关掉一切；返回
 * 进程 2 的宿主（会话还没打开）。不做断言。
 */
import { InboxDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { backgroundContext as BG } from '../../context'
import type { DrivenSendOptions, DurableSession, SubmitResult } from '../../durableSession'
import { stalled } from './faux'
import { makeHost, primeRoot, type TestHost, type TestHostOptions } from './host'
import { waitFor, withTimeout } from './wait'

export interface CrashOptions {
  /** 挂住的那条输入（缺省 'hello'） */
  text?: string
  requestId?: string
  driven?: DrivenSendOptions
  /** 挂住的那一轮后面排一条 follow-up */
  followUp?: { text: string; requestId?: string }
  /** 进程 1 的宿主选项 */
  host?: TestHostOptions
  /** 进程 2 的覆盖 */
  restart?: Partial<TestHostOptions>
  /** 进程 1 在挂住的发送之前做的事（先跑几轮等） */
  before?: (session: DurableSession, first: TestHost) => Promise<void>
  /** 进程 1 在挂住之后、重启之前做的事 */
  after?: (session: DurableSession, first: TestHost) => Promise<void>
}

export interface Crashed {
  /** 进程 2 的宿主（会话还没打开） */
  readonly t: TestHost
  /** 挂住的那次 submitUser（进程 1 关停时以 closed 收场） */
  readonly firstResult: Promise<SubmitResult>
  readonly followUpResult?: Promise<SubmitResult>
}

export async function crashWith(options: CrashOptions = {}): Promise<Crashed> {
  const first = await makeHost(options.host)
  const session = await first.open()
  await primeRoot(session)
  await options.before?.(session, first)
  const stall = stalled()
  first.kit.queue(stall.step)
  const firstResult = session.submitUser(options.text ?? 'hello', {
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    ...(options.driven === undefined ? {} : { driven: options.driven })
  })
  await stall.reached
  let followUpResult: Promise<SubmitResult> | undefined
  if (options.followUp !== undefined) {
    const { text, requestId } = options.followUp
    followUpResult = session.submitUser(text, {
      whenBusy: 'followUp',
      ...(requestId === undefined ? {} : { requestId })
    })
    await waitFor(
      async () =>
        ((await session.harness.snapshot(InboxDoc, ROOT_CONVERSATION_ID, BG))?.items.length ?? 0) >
        0,
      3000,
      'follow-up queued'
    )
  }
  await options.after?.(session, first)
  await withTimeout(first.host.closeAll(), 5000, 'closeAll process 1')
  const t = await first.restart(options.restart)
  return { t, firstResult, ...(followUpResult === undefined ? {} : { followUpResult }) }
}
