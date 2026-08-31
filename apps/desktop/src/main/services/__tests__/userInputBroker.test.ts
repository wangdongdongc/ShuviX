/**
 * userInputBroker —— 询问的**双向路由表**（M7′）。
 *
 * 这一层只测分派规则，所以除 logger 外什么都不 mock：参与方就是 `{name, claims, request,
 * respond}` 三件套 vi.fn，会话与 bot 各自的行为在另外两个文件里。要钉住的不变量有三条 ——
 *
 *   - **请求按 sessionId 找归属，答复按 requestId 找归属**。这不是对称美学上的选择：
 *     requestId 才是全局唯一的那个，而调用方（IPC）手上的 sessionId 只是它以为的那个，
 *     拿它去选参与方等于把前端的判断当成真相；
 *   - **两种失败必须可区分**。「通道根本没装」与「装了但没人认领这条会话」是两条完全
 *     不同的排错路径（前者是启动接线断了，后者是会话真的不活跃），同一条文案就把它们
 *     糊成一件事；
 *   - **`request` 的失败要原样往上抛**。broker 不是异常边界 —— 吞成 `{kind:'cancel'}`
 *     会让工具以为「用户取消了」，而真相是路由本身坏了。
 *
 * ⚠️ `resetUserInputParticipantsForTests()` **只有本文件能调**。botService /
 * sessionService 的参与方是模块加载的副作用，一个进程里只注册一次；在
 * botServiceUserInput / sessionServiceUserInput 里清空注册表等于把被测对象自己从路由表上
 * 摘掉，那两个文件之后的每一条都只会撞上「User input channel is not available」。
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

const mocks = vi.hoisted(() => ({ warn: vi.fn() }))

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {} })
}))

import {
  registerUserInputParticipant,
  requestUserInputFor,
  respondToUserInput,
  resetUserInputParticipantsForTests,
  type UserInputParticipant
} from '../userInputBroker'

const REQ: InputRequest = {
  id: 'req-1',
  kind: 'ask',
  toolName: 'bash',
  createdAt: 0,
  command: 'ls'
}
const ANSWER: InputResponse = { kind: 'ask', allowed: true }

interface Fake extends UserInputParticipant {
  claims: Mock<(sessionId: string) => boolean>
  request: Mock<(sessionId: string, request: InputRequest) => Promise<InputResponse>>
  respond: Mock<(requestId: string, response: InputResponse) => boolean>
}

/** 一个假参与方；`claims`/`respond` 缺省都是「不是我的」，各例只调自己关心的那一格 */
function fake(name: string, opts: { claims?: boolean; respond?: boolean } = {}): Fake {
  return {
    name,
    claims: vi.fn(() => opts.claims ?? false),
    request: vi.fn(async () => ANSWER),
    respond: vi.fn(() => opts.respond ?? false)
  }
}

/** 注册并返回，省掉每例两行 */
function register(p: Fake): Fake {
  registerUserInputParticipant(p)
  return p
}

beforeEach(() => {
  resetUserInputParticipantsForTests()
  mocks.warn.mockReset()
})

describe('requestUserInputFor —— 请求按 sessionId 找归属', () => {
  it('一个参与方都没注册 → reject「通道不可用」', async () => {
    // 这条只可能是启动接线断了（模块没被 import 到，注册的副作用没发生），
    // 与「会话不活跃」是两码事，所以文案逐字钉死
    await expect(requestUserInputFor('s1', REQ)).rejects.toThrow(
      'User input channel is not available'
    )
  })

  it('有参与方但都不认领 → reject「会话不活跃」，且没人被 request', async () => {
    const a = register(fake('a'))
    const b = register(fake('b'))

    await expect(requestUserInputFor('s1', REQ)).rejects.toThrow('Session s1 is not active')
    // 认领是**先于**投递的判断：没人认领时一次投递都不该发生，
    // 否则「不认领」就只是一句自我描述
    expect(a.request).not.toHaveBeenCalled()
    expect(b.request).not.toHaveBeenCalled()
  })

  it('两条拒绝理由不重合（「没装」与「没人认」得能一眼分开）', async () => {
    const empty = await requestUserInputFor('s1', REQ).catch((e: Error) => e.message)
    register(fake('a'))
    const unclaimed = await requestUserInputFor('s1', REQ).catch((e: Error) => e.message)

    expect(empty).not.toBe(unclaimed)
  })

  it('认领者拿到 (sessionId, request) 原件，返回的 Promise 原样透传', () => {
    const owner = register(fake('owner', { claims: true }))
    // 固定一个 Promise 实例来钉「不许在这里包一层」—— 包了 .then/.catch 就换了实例，
    // 而那正是 A-4 里异常被吞掉的前置动作
    const promise = Promise.resolve(ANSWER)
    owner.request.mockReturnValue(promise)

    expect(requestUserInputFor('s1', REQ)).toBe(promise)
    expect(owner.claims).toHaveBeenCalledWith('s1')
    expect(owner.request).toHaveBeenCalledTimes(1)
    expect(owner.request).toHaveBeenCalledWith('s1', REQ)
    expect(owner.request.mock.calls[0][1]).toBe(REQ)
  })

  it('认领者自己 reject 时原样上抛，**不吞成 {kind:"cancel"}**', async () => {
    const owner = register(fake('owner', { claims: true }))
    owner.request.mockRejectedValue(new Error('runtime went away'))

    // 吞成取消 = 骗工具说「用户不同意」，而真相是路由坏了；工具该收到的是 tool error
    await expect(requestUserInputFor('s1', REQ)).rejects.toThrow('runtime went away')
  })

  it('只有认领者被投递（不认领的那个一次都不碰）', async () => {
    const a = register(fake('a', { claims: false }))
    const b = register(fake('b', { claims: true }))

    await requestUserInputFor('s1', REQ)
    expect(a.request).not.toHaveBeenCalled()
    expect(b.request).toHaveBeenCalledTimes(1)
  })

  it('两个都认领时先注册的赢', async () => {
    // 各参与方的 claims 本该互斥（一个会话要么有根 agent、要么是 bot 会话），这里钉的是
    // 兜底行为不是可依赖的优先级 —— 真需要靠顺序消歧，说明某个 claims 写错了
    const first = register(fake('first', { claims: true }))
    const second = register(fake('second', { claims: true }))

    await requestUserInputFor('s1', REQ)
    expect(first.request).toHaveBeenCalledTimes(1)
    expect(second.request).not.toHaveBeenCalled()
  })
})

describe('respondToUserInput —— 答复按 requestId 找归属', () => {
  it('签名里根本没有 sessionId', () => {
    // 形参个数是这条设计的硬证据：只要有人为了「方便」把 sessionId 加回参数表，
    // 下一步必然是拿它去选参与方，于是又回到把前端判断当真相的老路
    expect(respondToUserInput.length).toBe(2)
  })

  it('第一个认领的短路，后面的不再被问', () => {
    const a = register(fake('a', { respond: false }))
    const b = register(fake('b', { respond: true }))
    const c = register(fake('c', { respond: true }))

    expect(respondToUserInput('req-1', ANSWER)).toBe(true)
    expect(a.respond).toHaveBeenCalledTimes(1)
    expect(b.respond).toHaveBeenCalledTimes(1)
    expect(c.respond).not.toHaveBeenCalled()
  })

  it('认领会话的那一方不一定持有这条 requestId', () => {
    // 派生 agent 的询问带着**根会话 id** 走 broker，而答复只带 requestId：
    // 两个方向的归属天然可以落在不同参与方身上，遍历才是对的
    const claimer = register(fake('claimer', { claims: true, respond: false }))
    const holder = register(fake('holder', { claims: false, respond: true }))

    expect(respondToUserInput('req-1', ANSWER)).toBe(true)
    expect(claimer.respond).toHaveBeenCalledTimes(1)
    expect(holder.respond).toHaveBeenCalledWith('req-1', ANSWER)
  })

  it('无人认领 → false，并留下一行带 requestId 的 warn', () => {
    register(fake('a'))
    register(fake('b'))

    expect(respondToUserInput('req-orphan', ANSWER)).toBe(false)
    // 静默丢弃会让用户对着一个「点了没反应」的按钮查半天：日志里必须能按 requestId 捞到
    expect(mocks.warn).toHaveBeenCalledTimes(1)
    expect(String(mocks.warn.mock.calls[0][0])).toContain('req-orphan')
  })

  it('response 连同 extra 原样交给持有者（不重建、不裁字段）', () => {
    const holder = register(fake('holder', { respond: true }))
    // extra 是工具自定义副作用（rememberPath 之类）的唯一载体，
    // broker 若在中间重建对象就会把它悄悄丢掉
    const response: InputResponse = {
      kind: 'ask',
      allowed: true,
      reason: 'user said yes',
      extra: { rememberPath: true }
    }

    expect(respondToUserInput('req-1', response)).toBe(true)
    expect(holder.respond.mock.calls[0][1]).toBe(response)
    expect(holder.respond.mock.calls[0][1]).toEqual({
      kind: 'ask',
      allowed: true,
      reason: 'user said yes',
      extra: { rememberPath: true }
    })
  })
})

describe('注册表本身', () => {
  it('同名可以重复注册（不去重，两份都会被问）', () => {
    // 钉住现状而不是主张它正确：`name` 只用于日志，注册表是一条按序遍历的列表。
    // 哪天改成按名去重，这条会红 —— 那正是该停下来想清楚「重复注册是配置错误还是
    // 合法的多实例」的时刻，而不是让行为静悄悄地变了
    const a = register(fake('bot'))
    const b = register(fake('bot'))

    expect(respondToUserInput('req-1', ANSWER)).toBe(false)
    expect(a.respond).toHaveBeenCalledTimes(1)
    expect(b.respond).toHaveBeenCalledTimes(1)
  })
})
