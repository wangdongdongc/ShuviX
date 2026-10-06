/**
 * createDbCredentialStore — pi-ai's CredentialStore over the provider rows.
 *
 * Contract under test: addressing (builtin by slug only, custom by row id, never crossed),
 * OAuth-over-key precedence, live reads, `modify` as the only serialized write path
 * (per provider id, shared with `delete`), delete = logout (OAuth only), and a list without
 * secrets.
 */
import { describe, expect, it } from 'vitest'
import type { Credential } from '@earendil-works/pi-ai'
import { createDbCredentialStore } from '../credentialStore'
import { builtinRow, customRow, fakePort, oauthCredential, storeOAuth } from './fakePort'

const XAI_UUID = '0193a7c2-0000-7000-8000-00000000a001'
const CUSTOM_ID = '0193a7c2-0000-7000-8000-00000000c001'

/** A promise plus its resolver, to hold a `modify` callback open. */
function gate<T = void>(): { promise: Promise<T>; open: (value: T) => void } {
  let open!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('read', () => {
  it('CS-01 API key only → {type: api_key, key}', async () => {
    const store = createDbCredentialStore(fakePort([builtinRow('xai', { apiKey: 'sk-1' })]))
    expect(await store.read('xai')).toEqual({ type: 'api_key', key: 'sk-1' })
  })

  it('CS-02 empty key and no OAuth → undefined (an empty string is not a credential)', async () => {
    const store = createDbCredentialStore(
      fakePort([builtinRow('xai', { apiKey: '' }), customRow(CUSTOM_ID, { apiKey: '   ' })])
    )
    expect(await store.read('xai')).toBeUndefined()
    expect(await store.read(CUSTOM_ID)).toBeUndefined()
  })

  it('CS-03 key + OAuth → the OAuth credential wins', async () => {
    const port = fakePort([builtinRow('xai', { apiKey: 'sk-1' })])
    storeOAuth(port, 'xai', { type: 'oauth', access: 'a', refresh: 'r', expires: 123 })
    expect(await createDbCredentialStore(port).read('xai')).toEqual({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 123
    })
  })

  it('CS-04 a builtin row with a legacy uuid id and name "XAI" answers to "xai"', async () => {
    const port = fakePort([builtinRow('XAI', { id: XAI_UUID, apiKey: 'sk-1' })])
    storeOAuth(port, XAI_UUID, { type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    expect(await createDbCredentialStore(port).read('xai')).toMatchObject({
      type: 'oauth',
      access: 'a'
    })
  })

  it('CS-05 a builtin row is not addressable by its row id (A6)', async () => {
    const port = fakePort([builtinRow('XAI', { id: XAI_UUID, apiKey: 'sk-1' })])
    expect(await createDbCredentialStore(port).read(XAI_UUID)).toBeUndefined()
  })

  it('CS-06 a custom row named "xai" and the builtin xai never see each other’s credential', async () => {
    const port = fakePort([
      customRow(CUSTOM_ID, { name: 'xai', apiKey: 'sk-custom' }),
      builtinRow('xai', { id: XAI_UUID, apiKey: 'sk-builtin' })
    ])
    storeOAuth(port, XAI_UUID, { type: 'oauth', access: 'builtin-oauth', refresh: 'r', expires: 1 })
    const store = createDbCredentialStore(port)
    expect(await store.read('xai')).toMatchObject({ type: 'oauth', access: 'builtin-oauth' })
    expect(await store.read(CUSTOM_ID)).toEqual({ type: 'api_key', key: 'sk-custom' })
  })

  it('CS-07 an unknown provider id → undefined', async () => {
    const store = createDbCredentialStore(fakePort([builtinRow('xai', { apiKey: 'sk-1' })]))
    expect(await store.read('openai')).toBeUndefined()
    expect(await store.read('no-such-row')).toBeUndefined()
  })

  it('CS-08 an expired OAuth credential is still returned (refresh is Models’ job)', async () => {
    const port = fakePort([builtinRow('xai')])
    storeOAuth(port, 'xai', { type: 'oauth', access: 'old', refresh: 'r', expires: 1 })
    expect(await createDbCredentialStore(port).read('xai')).toMatchObject({
      access: 'old',
      expires: 1
    })
  })

  it('CS-20 reads are live: no caching between calls', async () => {
    const port = fakePort([builtinRow('xai', { apiKey: 'sk-1' })])
    const store = createDbCredentialStore(port)
    expect(await store.read('xai')).toEqual({ type: 'api_key', key: 'sk-1' })
    port.rows[0].apiKey = 'sk-2'
    expect(await store.read('xai')).toEqual({ type: 'api_key', key: 'sk-2' })
    storeOAuth(port, 'xai', { type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    expect(await store.read('xai')).toMatchObject({ type: 'oauth' })
  })

  it('CS-21 a legacy OAuth record without `type` reads as OAuth (expires defaulting to 0)', async () => {
    const port = fakePort([builtinRow('xai')])
    port.oauth.set('xai', JSON.stringify({ access: 'a', refresh: 'r' }))
    expect(await createDbCredentialStore(port).read('xai')).toEqual({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 0
    })
  })

  it('CS-21b an unreadable OAuth record is "not logged in": the API key applies', async () => {
    const port = fakePort([builtinRow('xai', { apiKey: 'sk-1' })])
    const store = createDbCredentialStore(port)
    for (const json of [
      '{broken',
      '"str"',
      '{"access":"a"}',
      '{"type":"api_key","access":"a","refresh":"r"}'
    ]) {
      port.oauth.set('xai', json)
      expect(await store.read('xai'), json).toEqual({ type: 'api_key', key: 'sk-1' })
    }
  })
})

describe('modify', () => {
  it('CS-09 writes the full credential, extra fields included; result and later read are equal (A4)', async () => {
    const port = fakePort([builtinRow('xai')])
    const store = createDbCredentialStore(port)
    const credential = oauthCredential({
      access: 'a2',
      refresh: 'r2',
      expires: 42,
      accountId: 'acct-7',
      scope: ['x']
    })

    const result = await store.modify('xai', async () => credential)

    expect(port.oauthWrites).toEqual([['xai', { ...credential }]])
    expect(result).toEqual(credential)
    expect(await store.read('xai')).toEqual(result)
  })

  it('CS-10 fn → undefined: nothing written, resolves the current credential', async () => {
    const port = fakePort([builtinRow('xai', { apiKey: 'sk-1' })])
    const store = createDbCredentialStore(port)
    expect(await store.modify('xai', async () => undefined)).toEqual({
      type: 'api_key',
      key: 'sk-1'
    })
    expect(port.oauthWrites).toEqual([])
  })

  it('CS-11 fn receives the current credential', async () => {
    const port = fakePort([builtinRow('xai', { apiKey: 'sk-1' })])
    storeOAuth(port, 'xai', { type: 'oauth', access: 'a', refresh: 'r', expires: 5 })
    let seen: Credential | undefined
    await createDbCredentialStore(port).modify('xai', async (current) => {
      seen = current
      return undefined
    })
    expect(seen).toEqual({ type: 'oauth', access: 'a', refresh: 'r', expires: 5 })
  })

  it('CS-12 a rejecting fn propagates, writes nothing, and does not jam the chain', async () => {
    const port = fakePort([builtinRow('xai')])
    const store = createDbCredentialStore(port)
    await expect(
      store.modify('xai', async () => {
        throw new Error('refresh failed')
      })
    ).rejects.toThrow('refresh failed')
    expect(port.oauthWrites).toEqual([])

    await store.modify('xai', async () => oauthCredential({ access: 'after' }))
    expect(await store.read('xai')).toMatchObject({ access: 'after' })
  })

  it('CS-13 modifies of one id are serialized: the second sees the first’s write', async () => {
    const port = fakePort([builtinRow('xai')])
    const store = createDbCredentialStore(port)
    const hold = gate()
    const order: string[] = []

    const first = store.modify('xai', async () => {
      order.push('first:start')
      await hold.promise
      order.push('first:end')
      return oauthCredential({ access: 'from-first' })
    })
    let seenBySecond: Credential | undefined
    const second = store.modify('xai', async (current) => {
      order.push('second:start')
      seenBySecond = current
      return undefined
    })

    await tick()
    expect(order).toEqual(['first:start'])
    hold.open()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
    expect(seenBySecond).toMatchObject({ access: 'from-first' })
  })

  it('CS-14 different ids do not wait for each other', async () => {
    const port = fakePort([builtinRow('xai'), customRow(CUSTOM_ID)])
    const store = createDbCredentialStore(port)
    const hold = gate()
    const blocked = store.modify('xai', async () => {
      await hold.promise
      return undefined
    })
    let otherRan = false
    await store.modify(CUSTOM_ID, async () => {
      otherRan = true
      return undefined
    })
    expect(otherRan).toBe(true)
    hold.open()
    await blocked
  })

  it('CS-15 modify / delete for an id without a row reject and write nothing (A5)', async () => {
    const port = fakePort([builtinRow('xai')])
    const store = createDbCredentialStore(port)
    let called = false
    await expect(
      store.modify('openai', async () => {
        called = true
        return oauthCredential()
      })
    ).rejects.toThrow()
    await expect(store.delete('openai')).rejects.toThrow()
    expect(called).toBe(false)
    expect(port.oauthWrites).toEqual([])
    expect(port.clearCalls).toEqual([])
  })

  it('CS-18 an already-aborted signal rejects without calling fn', async () => {
    const port = fakePort([builtinRow('xai')])
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    let called = false
    await expect(
      createDbCredentialStore(port).modify(
        'xai',
        async () => {
          called = true
          return oauthCredential()
        },
        { signal: controller.signal }
      )
    ).rejects.toThrow('gone')
    await tick()
    expect(called).toBe(false)
    expect(port.oauthWrites).toEqual([])
  })

  it('CS-18b (pinned) aborting while fn runs still persists what fn produced; modify rejects', async () => {
    const port = fakePort([builtinRow('xai')])
    const store = createDbCredentialStore(port)
    const controller = new AbortController()
    const hold = gate()

    const pending = store.modify(
      'xai',
      async () => {
        await hold.promise
        return oauthCredential({ access: 'rotated', refresh: 'rotated-r' })
      },
      { signal: controller.signal }
    )
    await tick()
    controller.abort(new Error('caller left'))
    await expect(pending).rejects.toThrow('caller left')
    hold.open()
    await tick()

    // a rotated refresh token must not be dropped on the floor
    expect(await store.read('xai')).toMatchObject({ access: 'rotated', refresh: 'rotated-r' })
  })

  it('CS-22 (pinned) an api_key result writes the key when the port supports it; result = next read', async () => {
    const port = fakePort([builtinRow('xai', { apiKey: 'sk-old' })], [], { saveApiKey: true })
    const store = createDbCredentialStore(port)

    const result = await store.modify('xai', async () => ({ type: 'api_key', key: 'sk-new' }))
    expect(port.apiKeyWrites).toEqual([['xai', 'sk-new']])
    expect(result).toEqual({ type: 'api_key', key: 'sk-new' })
    expect(await store.read('xai')).toEqual(result)

    // with an OAuth record present the key is written but OAuth still wins (A4)
    storeOAuth(port, 'xai', { type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    const shadowed = await store.modify('xai', async () => ({ type: 'api_key', key: 'sk-newer' }))
    expect(port.rows[0].apiKey).toBe('sk-newer')
    expect(shadowed).toMatchObject({ type: 'oauth', access: 'a' })
    expect(await store.read('xai')).toEqual(shadowed)
  })

  it('CS-22b (pinned) an api_key result on a port without saveApiKey rejects and writes nothing', async () => {
    const port = fakePort([builtinRow('xai', { apiKey: 'sk-old' })])
    await expect(
      createDbCredentialStore(port).modify('xai', async () => ({ type: 'api_key', key: 'sk-new' }))
    ).rejects.toThrow(/cannot write API keys/)
    expect(port.rows[0].apiKey).toBe('sk-old')
  })
})

describe('delete', () => {
  it('CS-16 delete (logout) clears the OAuth record and keeps the API key', async () => {
    const port = fakePort([builtinRow('XAI', { id: XAI_UUID, apiKey: 'sk-1' })])
    storeOAuth(port, XAI_UUID, { type: 'oauth', access: 'a', refresh: 'r', expires: 1 })
    const store = createDbCredentialStore(port)

    await store.delete('xai')

    expect(port.clearCalls).toEqual([XAI_UUID])
    expect(await store.read('xai')).toEqual({ type: 'api_key', key: 'sk-1' })
  })

  it('CS-17 a delete queued behind an in-flight OAuth modify runs after it: no OAuth in the end', async () => {
    const port = fakePort([builtinRow('xai')])
    const store = createDbCredentialStore(port)
    const hold = gate()
    const refreshing = store.modify('xai', async () => {
      await hold.promise
      return oauthCredential({ access: 'refreshed' })
    })
    const loggingOut = store.delete('xai')

    await tick()
    expect(port.clearCalls).toEqual([])
    hold.open()
    await Promise.all([refreshing, loggingOut])

    expect(port.oauthWrites.map(([, c]) => c.access)).toEqual(['refreshed'])
    expect(port.clearCalls).toEqual(['xai'])
    expect(await store.read('xai')).toBeUndefined()
  })
})

describe('list', () => {
  it('CS-19 lists provider id + type for rows holding a credential, no secrets', async () => {
    const port = fakePort([
      builtinRow('XAI', { id: XAI_UUID, apiKey: 'sk-builtin' }),
      builtinRow('openai'),
      customRow(CUSTOM_ID, { apiKey: 'sk-custom' })
    ])
    storeOAuth(port, XAI_UUID, {
      type: 'oauth',
      access: 'secret-access',
      refresh: 'secret-refresh',
      expires: 1
    })

    const listed = await createDbCredentialStore(port).list()

    expect(listed).toEqual([
      { providerId: 'xai', type: 'oauth' },
      { providerId: CUSTOM_ID, type: 'api_key' }
    ])
    const json = JSON.stringify(listed)
    for (const secret of ['sk-builtin', 'sk-custom', 'secret-access', 'secret-refresh']) {
      expect(json).not.toContain(secret)
    }
  })
})
