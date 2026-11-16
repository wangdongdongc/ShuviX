/**
 * webSearch:* —— `web_search` 搜索方式设置的四条通道：密钥只进不出，交回界面的只有「存没存」和末四位。
 *
 * 通道经注册表 + IPC 适配器挂到（替身）ipcMain 上，后面是**真的** services/webSearchApiService；DAO 是内存里的
 * Map，网络是假的会话 fetch。所以每条通道的回答就是界面真的会拿到的东西。
 *
 *   WH-1  恰好四条通道
 *   WH-2  config：设置页那一份
 *   WH-3  setKey：存下（去空白），回答是 config，不含密钥
 *   WH-4  setKey 的参数缺了 / 不是对象：不在处理函数里崩，按「不认识的 API」拒绝
 *   WH-5  服务的拒绝原样到调用方，消息里没有提交的密钥
 *   WH-6  deleteKey / test 带着 provider 转过去，结果原样交回
 *   WH-7  一整套走下来，四条通道的回答里都没有密钥；test 只回原因那一段
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  settings: new Map<string, string>(),
  keys: new Map<string, string>(),
  sessionFetch: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      h.handlers.set(channel, handler)
    },
    on: () => {}
  },
  BrowserWindow: {},
  webContents: { fromId: () => undefined }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
vi.mock('../../dao/settingsDao', () => ({
  settingsDao: { findByKey: (key: string) => h.settings.get(key) }
}))
vi.mock('../../dao/webSearchKeyDao', () => ({
  webSearchKeyDao: {
    find: (provider: string) => h.keys.get(provider) ?? '',
    set: (provider: string, key: string) => void h.keys.set(provider, key),
    delete: (provider: string) => void h.keys.delete(provider)
  }
}))
vi.mock('../../services/readPageRenderer', () => ({
  readUrlSession: () => ({ fetch: h.sessionFetch })
}))

import { attachIpcAdapter } from '../ipcAdapter'
import { registerWebSearchHandlers } from '../webSearchHandlers'

registerWebSearchHandlers()
attachIpcAdapter()

const KEY = ['tvly', 'SECRETSECRET', '1234'].join('-')
const EXA_KEY = ['exa', 'ANOTHERSECRET', '9876'].join('-')

/** 像渲染端 invoke 那样调一条通道（处理函数同步抛的也成为拒绝） */
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve().then(() => {
    const handler = h.handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return handler({ sender: { id: 1 } }, ...args)
  })

const respond = (status: number, json: unknown): unknown => ({ status, json: async () => json })

beforeEach(() => {
  h.settings.clear()
  h.keys.clear()
  h.sessionFetch.mockReset()
})

describe('webSearch:*', () => {
  it('WH-1 exactly four channels', () => {
    expect([...h.handlers.keys()].filter((c) => c.startsWith('webSearch:')).sort()).toEqual([
      'webSearch:config',
      'webSearch:deleteKey',
      'webSearch:setKey',
      'webSearch:test'
    ])
  })

  it('WH-2 webSearch:config answers the settings page’s view', async () => {
    h.keys.set('exa', EXA_KEY)
    h.settings.set('webSearch.provider', 'exa')
    expect(await invoke('webSearch:config')).toEqual({
      provider: 'exa',
      browserEngine: 'Google',
      keys: { tavily: { saved: false, last4: '' }, exa: { saved: true, last4: '9876' } }
    })
  })

  it('WH-3 webSearch:setKey stores the trimmed key and answers the config without it', async () => {
    const answer = await invoke('webSearch:setKey', { provider: 'tavily', apiKey: ` ${KEY}\n` })
    expect(h.keys.get('tavily')).toBe(KEY)
    expect(answer).toMatchObject({ keys: { tavily: { saved: true, last4: '1234' } } })
    expect(JSON.stringify(answer)).not.toContain(KEY)
  })

  it.each([[undefined], [null], [{}]])(
    'WH-4 webSearch:setKey with %j is refused as an unknown API, not a crash',
    async (params) => {
      await expect(invoke('webSearch:setKey', params)).rejects.toThrow(
        'Unknown search API: undefined'
      )
      expect(h.keys.size).toBe(0)
    }
  )

  it('WH-5 the service’s refusals reach the caller without the submitted key', async () => {
    const unknown = await invoke('webSearch:setKey', { provider: 'google', apiKey: KEY }).catch(
      (error: Error) => error
    )
    expect(unknown).toBeInstanceOf(Error)
    expect((unknown as Error).message).toBe('Unknown search API: google')
    expect((unknown as Error).message).not.toContain(KEY)

    await expect(invoke('webSearch:setKey', { provider: 'tavily', apiKey: '   ' })).rejects.toThrow(
      'The API key is empty'
    )
    await expect(invoke('webSearch:deleteKey', 'browser')).rejects.toThrow(/^Unknown search API/)
    await expect(invoke('webSearch:test', 'browser')).rejects.toThrow(/^Unknown search API/)
    expect(h.keys.size).toBe(0)
    expect(h.sessionFetch).not.toHaveBeenCalled()
  })

  it('WH-6 deleteKey and test act on the provider they are given', async () => {
    h.keys.set('tavily', KEY)
    h.keys.set('exa', EXA_KEY)
    h.sessionFetch.mockResolvedValue(
      respond(200, { results: [{ title: 't', url: 'https://example.com', content: 'c' }] })
    )
    expect(await invoke('webSearch:test', 'exa')).toEqual({
      ok: true,
      count: 1,
      ms: expect.any(Number)
    })
    expect(h.sessionFetch).toHaveBeenCalledTimes(1)
    expect(h.sessionFetch.mock.calls[0][0]).toBe('https://api.exa.ai/search')

    expect(await invoke('webSearch:deleteKey', 'exa')).toMatchObject({
      keys: { tavily: { saved: true, last4: '1234' }, exa: { saved: false, last4: '' } }
    })
    expect(h.keys.has('exa')).toBe(false)
    expect(h.keys.get('tavily')).toBe(KEY)
  })

  it('WH-7 through set, config, test and delete no answer carries the key', async () => {
    const answers: unknown[] = []
    answers.push(await invoke('webSearch:setKey', { provider: 'tavily', apiKey: KEY }))
    answers.push(await invoke('webSearch:config'))

    h.sessionFetch.mockResolvedValue(respond(401, { detail: { error: `Invalid API key: ${KEY}` } }))
    const tested = (await invoke('webSearch:test', 'tavily')) as { ok: boolean; error: string }
    answers.push(tested)
    expect(tested.ok).toBe(false)
    expect(Object.keys(tested).sort()).toEqual(['error', 'ok'])
    expect(tested.error).toContain('Tavily rejected the API key (401)')
    expect(tested.error).not.toContain('Tell the user')

    answers.push(await invoke('webSearch:deleteKey', 'tavily'))
    expect(JSON.stringify(answers)).not.toContain(KEY)
    expect(JSON.stringify(answers)).not.toContain(KEY.slice(-5))
  })
})
