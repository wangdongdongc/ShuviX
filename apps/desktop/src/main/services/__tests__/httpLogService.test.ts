/**
 * httpLogService 单测 —— 记录开关（默认关闭）。
 *
 * 关键约定：关闭时 logRequest 返回空串且**不序列化 payload** —— payload 是整段上下文
 * 快照（含 base64 图片可达数 MB），agent 循环每步都会调用，序列化本身就是成本。
 * 返回空串又让上游的 `if (logId)` 守卫跳过用量回填（harnessSession / eventHandler）。
 *
 *   H1 内存会话（sessionRecords.isEphemeral）开着记录也不记：一行日志就是整段对话的快照，
 *      记下来它就不再只在内存里了。持久会话对照照常记。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockDao, setting } = vi.hoisted(() => ({
  mockDao: {
    insert: vi.fn(),
    updateUsage: vi.fn(),
    list: vi.fn(() => []),
    getById: vi.fn(),
    clear: vi.fn(),
    deleteBySessionId: vi.fn()
  },
  setting: { value: undefined as string | undefined, get: vi.fn() }
}))

vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: mockDao }))
// 门闩还问 sessionRecords.isEphemeral（纯内存判定）；持久会话那一侧不碰表，不拉起真库。
// pick 只给 H1：插内存会话时 sessionRecords 要先问库里有没有同 id 的行
vi.mock('../../dao/sessionDao', () => ({ sessionDao: { pick: () => undefined } }))
vi.mock('../settingsService', () => ({
  settingsService: {
    get: (key: string) => {
      setting.get(key)
      return setting.value
    }
  }
}))

import { httpLogService, HTTP_LOG_ENABLED_KEY } from '../httpLogService'
import { sessionRecords } from '../sessionRecords'

/** 带 toJSON 探针的 payload：被序列化过就会留下痕迹 */
function probePayload(): { payload: unknown; toJSON: ReturnType<typeof vi.fn> } {
  const toJSON = vi.fn(() => ({ messages: [] }))
  return { payload: { toJSON }, toJSON }
}

const REQUEST = { sessionId: 's1', provider: 'anthropic', model: 'claude-opus-5' }

beforeEach(() => {
  vi.clearAllMocks()
  setting.value = undefined
  sessionRecords.clearEphemeralForTests()
})

describe('httpLogService 记录开关', () => {
  it('设置缺省时关闭：不写库、不序列化、返回空串', () => {
    const { payload, toJSON } = probePayload()

    const id = httpLogService.logRequest({ ...REQUEST, payload })

    expect(id).toBe('')
    expect(mockDao.insert).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()
    expect(setting.get).toHaveBeenCalledWith(HTTP_LOG_ENABLED_KEY)
  })

  it("显式 'false' 同样关闭", () => {
    setting.value = 'false'
    expect(httpLogService.logRequest({ ...REQUEST, payload: {} })).toBe('')
    expect(mockDao.insert).not.toHaveBeenCalled()
  })

  it("开启（'true'）后写入完整请求体并返回日志 ID", () => {
    setting.value = 'true'
    const { payload, toJSON } = probePayload()

    const id = httpLogService.logRequest({ ...REQUEST, payload })

    expect(id).not.toBe('')
    expect(toJSON).toHaveBeenCalled()
    expect(mockDao.insert).toHaveBeenCalledTimes(1)
    const row = mockDao.insert.mock.calls[0][0]
    expect(row).toMatchObject({
      id,
      sessionId: 's1',
      provider: 'anthropic',
      model: 'claude-opus-5'
    })
    expect(JSON.parse(row.payload)).toEqual({ messages: [] })
  })

  it('每次调用实时读设置：关→开无需重启会话', () => {
    expect(httpLogService.logRequest({ ...REQUEST, payload: {} })).toBe('')
    setting.value = 'true'
    expect(httpLogService.logRequest({ ...REQUEST, payload: {} })).not.toBe('')
    expect(mockDao.insert).toHaveBeenCalledTimes(1)
  })

  it('用量回填与查询不受开关影响（关闭前已记录的行仍能补全/查看）', () => {
    httpLogService.updateUsage('log-1', 10, 20, 30, '{"content":[]}')
    expect(mockDao.updateUsage).toHaveBeenCalledWith('log-1', 10, 20, 30, '{"content":[]}')

    httpLogService.list({ sessionId: 's1' })
    expect(mockDao.list).toHaveBeenCalledWith({ sessionId: 's1' })
  })
})

describe('H1 内存会话不记请求日志', () => {
  it('H1 开着记录：内存会话回空串、不写库、不序列化；持久会话对照照常记', () => {
    setting.value = 'true'
    sessionRecords.insert(
      {
        id: 'mem-1',
        title: 'mem',
        projectId: null,
        parentId: null,
        settings: {},
        createdAt: 1,
        updatedAt: 1,
        lastActiveAt: 1
      },
      { ephemeral: true }
    )
    const { payload, toJSON } = probePayload()

    expect(httpLogService.logRequest({ ...REQUEST, sessionId: 'mem-1', payload })).toBe('')
    expect(mockDao.insert).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()

    const id = httpLogService.logRequest({ ...REQUEST, payload: {} })
    expect(id).not.toBe('')
    expect(mockDao.insert).toHaveBeenCalledTimes(1)
    expect(mockDao.insert.mock.calls[0][0]).toMatchObject({ id, sessionId: 's1' })
  })
})
