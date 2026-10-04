/**
 * The DB credential store under a real pi-ai `Models` — OAuth refresh, login and logout as pi
 * drives them (refresh inside `modify`, double-checked under the store's lock).
 *
 * The provider is pi's faux provider re-labelled as "xai" with real-looking auth: an env-key
 * api-key method plus an OAuth method whose refresh/login are spies. The port holds a builtin
 * row with a legacy uuid id and name "XAI", so every credential write must land on the row id
 * while pi addresses it by slug.
 */
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  createModels,
  envApiKeyAuth,
  fauxProvider,
  ModelsError,
  type AuthInteraction,
  type MutableModels,
  type OAuthCredential,
  type Provider
} from '@earendil-works/pi-ai'
import { createDbCredentialStore } from '../credentialStore'
import {
  builtinRow,
  fakeAuthContext,
  fakePort,
  oauthCredential,
  storeOAuth,
  type FakePort
} from './fakePort'

const XAI_UUID = '0193a7c2-0000-7000-8000-00000000a001'
const HOUR = 60 * 60 * 1000

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

interface Setup {
  port: FakePort
  models: MutableModels
  refresh: Mock<(credential: OAuthCredential, signal: AbortSignal) => Promise<OAuthCredential>>
  login: Mock<() => Promise<OAuthCredential>>
}

function setup(options: { apiKey?: string; oauth?: OAuthCredential } = {}): Setup {
  const port = fakePort([builtinRow('XAI', { id: XAI_UUID, apiKey: options.apiKey ?? '' })])
  if (options.oauth) storeOAuth(port, XAI_UUID, options.oauth)
  const refresh =
    vi.fn<(credential: OAuthCredential, signal: AbortSignal) => Promise<OAuthCredential>>()
  const login = vi.fn<() => Promise<OAuthCredential>>()
  const faux = fauxProvider({ provider: 'xai' })
  const provider: Provider = {
    ...faux.provider,
    auth: {
      apiKey: envApiKeyAuth('k', ['XAI_API_KEY']),
      oauth: {
        name: 'xAI subscription',
        login,
        refresh,
        toAuth: async (credential) => ({ apiKey: credential.access })
      }
    }
  }
  const models = createModels({
    credentials: createDbCredentialStore(port),
    authContext: fakeAuthContext()
  })
  models.setProvider(provider)
  return { port, models, refresh, login }
}

const expiringSoon = (over: Partial<OAuthCredential> = {}): OAuthCredential =>
  oauthCredential({ access: 'a1', refresh: 'r1', expires: Date.now() + 60_000, ...over })

const interaction: AuthInteraction = {
  prompt: () => Promise.reject(new Error('no prompts in this test')),
  notify: () => {}
}

describe('OAuth refresh through Models.getAuth', () => {
  it('CM-01 an expiring token is refreshed once; the rotated credential (extras kept) lands on the row', async () => {
    const { port, models, refresh } = setup({ oauth: expiringSoon() })
    const rotated = oauthCredential({
      access: 'a2',
      refresh: 'r2',
      expires: Date.now() + HOUR,
      accountId: 'acct-1'
    })
    refresh.mockResolvedValue(rotated)

    const auth = await models.getAuth('xai')

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh.mock.calls[0][0]).toMatchObject({ access: 'a1', refresh: 'r1' })
    expect(port.oauthWrites).toEqual([[XAI_UUID, { ...rotated }]])
    expect(auth?.auth.apiKey).toBe('a2')
    expect(auth?.source).toBe('OAuth')
  })

  it('CM-02 three concurrent requests refresh once, save once, and all get the new token', async () => {
    const { port, models, refresh } = setup({ oauth: expiringSoon() })
    const hold = gate()
    refresh.mockImplementation(async () => {
      await hold.promise
      return oauthCredential({ access: 'a2', refresh: 'r2', expires: Date.now() + HOUR })
    })

    const pending = [models.getAuth('xai'), models.getAuth('xai'), models.getAuth('xai')]
    await new Promise((resolve) => setTimeout(resolve, 0))
    hold.open()
    const results = await Promise.all(pending)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(port.oauthWrites).toHaveLength(1)
    expect(results.map((r) => r?.auth.apiKey)).toEqual(['a2', 'a2', 'a2'])
  })

  it('CM-03 the next refresh receives the rotated refresh token', async () => {
    const { models, refresh } = setup({ oauth: expiringSoon() })
    refresh
      .mockResolvedValueOnce(
        oauthCredential({ access: 'a2', refresh: 'r2', expires: Date.now() + 60_000 })
      )
      .mockResolvedValueOnce(
        oauthCredential({ access: 'a3', refresh: 'r3', expires: Date.now() + HOUR })
      )

    await models.getAuth('xai')
    const second = await models.getAuth('xai')

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(refresh.mock.calls[1][0].refresh).toBe('r2')
    expect(second?.auth.apiKey).toBe('a3')
  })

  it('CM-04 a failed refresh rejects with ModelsError "oauth", keeps the stored credential, no key fallback', async () => {
    const stored = expiringSoon()
    const { port, models, refresh } = setup({ apiKey: 'sk-1', oauth: stored })
    refresh.mockRejectedValue(new Error('invalid_grant'))

    const error = await models.getAuth('xai').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ModelsError)
    expect((error as ModelsError).code).toBe('oauth')
    expect(port.oauthWrites).toEqual([])
    expect(JSON.parse(port.oauth.get(XAI_UUID)!)).toEqual(stored)
  })

  it('CM-05 a token valid for another hour is used as-is', async () => {
    const { models, refresh } = setup({
      oauth: oauthCredential({ access: 'fresh', expires: Date.now() + HOUR })
    })
    const auth = await models.getAuth('xai')
    expect(refresh).not.toHaveBeenCalled()
    expect(auth?.auth.apiKey).toBe('fresh')
  })

  it('CM-06 OAuth + API key → OAuth is used', async () => {
    const { models } = setup({ apiKey: 'sk-1', oauth: oauthCredential({ access: 'fresh' }) })
    const auth = await models.getAuth('xai')
    expect(auth?.source).toBe('OAuth')
    expect(auth?.auth.apiKey).toBe('fresh')
  })
})

describe('login / logout through Models', () => {
  it('CM-07 logout clears OAuth and keeps the key, which takes over', async () => {
    const { port, models } = setup({ apiKey: 'sk-1', oauth: oauthCredential({ access: 'fresh' }) })

    await models.logout('xai')

    expect(port.clearCalls).toEqual([XAI_UUID])
    const auth = await models.getAuth('xai')
    expect(auth?.source).toBe('stored credential')
    expect(auth?.auth.apiKey).toBe('sk-1')
  })

  it('CM-08 logout during a refresh: the refresh writes first, then the delete; no OAuth remains', async () => {
    const { port, models, refresh } = setup({ oauth: expiringSoon() })
    const hold = gate()
    refresh.mockImplementation(async () => {
      await hold.promise
      return oauthCredential({ access: 'a2', refresh: 'r2', expires: Date.now() + HOUR })
    })

    const authorizing = models.getAuth('xai')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const loggingOut = models.logout('xai')
    hold.open()
    await Promise.all([authorizing, loggingOut])

    expect(port.oauthWrites.map(([, credential]) => credential.access)).toEqual(['a2'])
    expect(port.clearCalls).toEqual([XAI_UUID])
    expect(port.oauth.has(XAI_UUID)).toBe(false)
    expect(await models.getAuth('xai')).toBeUndefined()
  })

  it('CM-09 login persists the full credential the flow returned', async () => {
    const { port, models, login } = setup()
    const credential = oauthCredential({
      access: 'new',
      refresh: 'new-r',
      expires: Date.now() + HOUR,
      accountId: 'a'
    })
    login.mockResolvedValue(credential)

    const returned = await models.login('xai', 'oauth', interaction)

    expect(returned).toEqual(credential)
    expect(port.oauthWrites).toEqual([[XAI_UUID, { ...credential }]])
  })

  it('CM-10 checkAuth: key only → api_key; OAuth → oauth/OAuth; nothing → undefined', async () => {
    expect(await setup({ apiKey: 'sk-1' }).models.checkAuth('xai')).toMatchObject({
      type: 'api_key'
    })
    expect(await setup({ oauth: oauthCredential() }).models.checkAuth('xai')).toEqual({
      type: 'oauth',
      source: 'OAuth'
    })
    expect(await setup().models.checkAuth('xai')).toBeUndefined()
  })
})
