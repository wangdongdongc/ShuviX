/**
 * P4-06 guard for the env-only protocol probe (`e2e/live/protocols.probe.ts` + its env loader).
 *
 * 1. **Static:** the probe files never reach the user's real data or launch the app — none of the
 *    real-instance paths, none of the DB-reading probes' helpers, no Electron app launch, no
 *    ambient provider env var (every `process.env.X` is a `SHUVIX_PROBE_*` name or `PROBE_OUT`).
 *    The scripts run plain vitest (no build), and the normal unit config never picks the probe up.
 * 2. **Env loader:** prefix filtering, file vs process precedence, family table, default model
 *    choice against pi's real catalog, redaction and the "no key substring" check.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { describe, expect, it } from 'vitest'
import {
  assertNoSecrets,
  collectProbeEnv,
  familyEnvVars,
  familyRunnable,
  pickDefaultModel,
  probeOptions,
  redact,
  resolveFamilies,
  secretsOf,
  SECRET_WINDOW
} from '../../../../../e2e/live/protocolProbeEnv'

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const PROBE_FILES = ['e2e/live/protocols.probe.ts', 'e2e/live/protocolProbeEnv.ts']
const read = (rel: string): string => readFileSync(join(DESKTOP, rel), 'utf8')

/** Literal markers of the real instance and of the DB-reading probes. */
const BANNED_LITERALS = [
  'Application Support',
  'shuvix.db',
  '.session-state',
  'pickRealModel',
  'launchApp'
]
/** Electron app launch, the real profile directory, and importing the DB-reading probes. */
const BANNED_PATTERNS: readonly [string, RegExp][] = [
  ["import from 'electron'", /from\s+['"]electron['"]/],
  ["require('electron')", /require\(\s*['"]electron['"]\s*\)/],
  ['playwright _electron', /_electron\b/],
  ['electron-vite', /electron-vite/],
  ['e2e launch harness', /harness\/launch/],
  ['~/.shuvix profile directory', /\.shuvix(?:\/|\b)/],
  ['the DB-reading probes', /from\s+['"]\.\/(?:probe|review\.probe|subsession\.probe)['"]/]
]

describe('P4-06 protocol probe · static guard', () => {
  const sources = PROBE_FILES.map((rel) => [rel, read(rel)] as const)

  it('the probe files exist and are not empty', () => {
    for (const [rel, text] of sources) expect(text.length, rel).toBeGreaterThan(1000)
  })

  it.each(BANNED_LITERALS)('no probe file mentions %s', (literal) => {
    for (const [rel, text] of sources) expect(text.includes(literal), rel).toBe(false)
  })

  it.each(BANNED_PATTERNS)('no probe file has %s', (_label, pattern) => {
    for (const [rel, text] of sources) expect(pattern.test(text), rel).toBe(false)
  })

  it('every process.env read is a SHUVIX_PROBE_* name or PROBE_OUT (no ambient provider keys)', () => {
    for (const [rel, text] of sources) {
      const names = [...text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])
      const bracketed = [...text.matchAll(/process\.env\[/g)]
      expect(bracketed, rel).toEqual([])
      for (const name of names) expect(name, rel).toMatch(/^(SHUVIX_PROBE_[A-Z0-9_]+|PROBE_OUT)$/)
    }
  })

  it('the registry gets a sealed AuthContext and the keys an in-memory port', () => {
    const probe = read('e2e/live/protocols.probe.ts')
    expect(probe).toMatch(/authContext:\s*SEALED_AUTH/)
    expect(probe).toMatch(/env:\s*async\s*\(\)\s*=>\s*undefined/)
    expect(probe).toMatch(/new MemoryStorage\(\)/)
  })

  it('the scripts run plain vitest (no build); the unit config never includes e2e/', () => {
    const desktop = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    const root = JSON.parse(read('../../package.json')) as { scripts: Record<string, string> }
    for (const name of ['probe:protocols', 'probe:protocols:dry']) {
      expect(desktop.scripts[name]).toMatch(
        /^vitest run --config vitest\.config\.protocols\.ts .*e2e\/live\/protocols\.probe\.ts$/
      )
      expect(desktop.scripts[name]).not.toMatch(/electron-vite|build/)
      expect(root.scripts[name]).toBe(`npm run ${name} -w shuvix`)
    }
    expect(desktop.scripts['probe:protocols:dry']).toContain('--mode probe-dry')
    expect(read('vitest.config.ts')).not.toMatch(/['"]e2e\//)
  })

  it("the protocol scripts' vitest include cannot match the DB-reading probes", async () => {
    const { default: config } = await import('../../../../../vitest.config.protocols')
    for (const mode of ['test', 'probe-dry']) {
      const resolved = (config as unknown as (env: { mode: string; command: string }) => unknown)({
        mode,
        command: 'serve'
      }) as { test: { include: string[]; env?: Record<string, string> } }
      // One literal path, no glob syntax: it names exactly one file, never probe.ts /
      // review.probe.ts / subsession.probe.ts (which read the real app database)
      expect(resolved.test.include, mode).toEqual(['e2e/live/protocols.probe.ts'])
      for (const entry of resolved.test.include) expect(entry).not.toMatch(/[*?[\]{}!]/)
      for (const dbProbe of ['probe.ts', 'review.probe.ts', 'subsession.probe.ts']) {
        expect(resolved.test.include).not.toContain(`e2e/live/${dbProbe}`)
      }
      expect(resolved.test.env?.SHUVIX_PROBE_DRY, mode).toBe(mode === 'probe-dry' ? '1' : undefined)
    }
  })
})

describe('P4-06 protocol probe · env loader', () => {
  it('only SHUVIX_PROBE_* names survive; the process env wins over the file; blanks drop', () => {
    const file = [
      '# keys',
      'SHUVIX_PROBE_ANTHROPIC_KEY=from-file',
      'export SHUVIX_PROBE_OPENAI_KEY="quoted value"',
      'ANTHROPIC_API_KEY=ambient-must-not-leak',
      'SHUVIX_PROBE_EMPTY=',
      "SHUVIX_PROBE_MAX_USD='0.5'"
    ].join('\n')
    const env = collectProbeEnv(
      {
        SHUVIX_PROBE_ANTHROPIC_KEY: ' from-process ',
        OPENAI_API_KEY: 'ambient',
        PATH: '/bin'
      },
      file
    )
    expect(env).toEqual({
      SHUVIX_PROBE_ANTHROPIC_KEY: 'from-process',
      SHUVIX_PROBE_OPENAI_KEY: 'quoted value',
      SHUVIX_PROBE_MAX_USD: '0.5'
    })
  })

  it('run options: dry flag, budget default and floor, report path', () => {
    expect(probeOptions({}, {}, '/tmp/r.md')).toEqual({ dry: false, maxUsd: 1, out: '/tmp/r.md' })
    expect(
      probeOptions(
        { SHUVIX_PROBE_DRY: 'true', SHUVIX_PROBE_MAX_USD: '0.25' },
        { PROBE_OUT: '/x.md', SHUVIX_PROBE_ENV_FILE: '/keys.env' },
        '/tmp/r.md'
      )
    ).toEqual({ dry: true, maxUsd: 0.25, out: '/x.md', envFile: '/keys.env' })
    expect(probeOptions({ SHUVIX_PROBE_MAX_USD: '-3' }, {}, '/r').maxUsd).toBe(1)
  })

  it('the family table: every §5 family, keyed by its own env vars', () => {
    const families = resolveFamilies({
      SHUVIX_PROBE_ANTHROPIC_KEY: 'a',
      SHUVIX_PROBE_KIMI_KEY: 'k',
      SHUVIX_PROBE_KIMI_MODEL: 'kimi-for-coding',
      SHUVIX_PROBE_COMPLETIONS_PROVIDER: 'Groq',
      SHUVIX_PROBE_COMPLETIONS_KEY: 'g'
    })
    expect(families.map((family) => family.id)).toEqual([
      'anthropic',
      'openai',
      'completions',
      'google',
      'mistral',
      'xai',
      'kimi',
      'custom'
    ])
    const byId = Object.fromEntries(families.map((family) => [family.id, family]))
    expect(byId.anthropic).toMatchObject({
      key: 'a',
      target: { kind: 'builtin', slug: 'anthropic' }
    })
    expect(byId.kimi).toMatchObject({
      key: 'k',
      model: 'kimi-for-coding',
      api: 'anthropic-messages',
      target: { slug: 'kimi-coding' }
    })
    expect(byId.completions).toMatchObject({
      key: 'g',
      api: 'openai-completions',
      target: { slug: 'groq' }
    })
    expect(byId.xai).toMatchObject({ api: 'openai-responses', target: { slug: 'xai' } })
    expect(families.filter(familyRunnable).map((family) => family.id)).toEqual([
      'anthropic',
      'completions',
      'kimi'
    ])
    expect(familyEnvVars(byId.completions)).toEqual([
      'SHUVIX_PROBE_COMPLETIONS_PROVIDER',
      'SHUVIX_PROBE_COMPLETIONS_KEY',
      'SHUVIX_PROBE_COMPLETIONS_MODEL'
    ])
  })

  it('config errors keep a family from running even with a key', () => {
    const bad = resolveFamilies({
      SHUVIX_PROBE_COMPLETIONS_PROVIDER: 'nope',
      SHUVIX_PROBE_COMPLETIONS_KEY: 'x',
      SHUVIX_PROBE_CUSTOM_KEY: 'y'
    })
    const byId = Object.fromEntries(bad.map((family) => [family.id, family]))
    expect(byId.completions!.configError).toMatch(/COMPLETIONS_PROVIDER/)
    expect(byId.custom!.configError).toMatch(/CUSTOM_BASE_URL/)
    expect(bad.filter(familyRunnable)).toEqual([])

    const headers = resolveFamilies({
      SHUVIX_PROBE_CUSTOM_BASE_URL: 'http://localhost:8080/v1',
      SHUVIX_PROBE_CUSTOM_KEY: 'y',
      SHUVIX_PROBE_CUSTOM_MODEL: 'm',
      SHUVIX_PROBE_CUSTOM_HEADERS: '["not", "an object"]'
    }).find((family) => family.id === 'custom')!
    expect(headers.configError).toMatch(/CUSTOM_HEADERS/)

    const good = resolveFamilies({
      SHUVIX_PROBE_CUSTOM_BASE_URL: 'http://localhost:8080/v1',
      SHUVIX_PROBE_CUSTOM_KEY: 'y',
      SHUVIX_PROBE_CUSTOM_MODEL: 'm',
      SHUVIX_PROBE_CUSTOM_PROTOCOL: 'anthropic-messages',
      SHUVIX_PROBE_CUSTOM_HEADERS: '{"X-Tenant":"secret-tenant-header"}',
      SHUVIX_PROBE_CUSTOM_VISION: '1'
    }).find((family) => family.id === 'custom')!
    expect(familyRunnable(good)).toBe(true)
    expect(good).toMatchObject({
      api: 'anthropic-messages',
      target: {
        kind: 'custom',
        protocol: 'anthropic-messages',
        headers: { 'X-Tenant': 'secret-tenant-header' },
        vision: true
      }
    })
    // keys and header values are secrets; fragments under 4 characters are noise
    expect(secretsOf([good])).toEqual(['secret-tenant-header'])
    expect(secretsOf([{ ...good, key: 'long-enough-key' }])).toEqual([
      'long-enough-key',
      'secret-tenant-header'
    ])
  })

  it("every builtin family's default model exists in pi's catalog with the family's protocol", () => {
    const catalogs = new Map(builtinProviders().map((provider) => [provider.id, provider]))
    const families = resolveFamilies({
      SHUVIX_PROBE_COMPLETIONS_PROVIDER: 'deepseek'
    }).filter((family) => family.target.kind === 'builtin')
    const slugs = [
      ...families.map((family) => (family.target.kind === 'builtin' ? family.target.slug : '')),
      'groq',
      'openrouter'
    ]
    for (const slug of slugs) {
      const family =
        families.find((f) => f.target.kind === 'builtin' && f.target.slug === slug) ??
        families.find((f) => f.id === 'completions')!
      const provider = catalogs.get(slug)
      expect(provider, slug).toBeDefined()
      const model = pickDefaultModel(provider!.getModels(), family.api)
      expect(model, slug).toBeDefined()
      expect(model!.api, slug).toBe(family.api)
    }
  })

  it('pickDefaultModel: cheapest priced reasoning model, then cheapest priced, then the first', () => {
    type CatalogModel = Parameters<typeof pickDefaultModel>[0][number]
    const model = (id: string, price: number, reasoning: boolean, api = 'x'): CatalogModel =>
      ({
        id,
        api,
        reasoning,
        cost: { input: price, output: price, cacheRead: 0, cacheWrite: 0 }
      }) as unknown as CatalogModel
    expect(
      pickDefaultModel(
        [
          model('free', 0, true),
          model('big-r', 9, true),
          model('small-r', 2, true),
          model('tiny', 1, false)
        ],
        'x'
      )?.id
    ).toBe('small-r')
    expect(pickDefaultModel([model('free', 0, true), model('tiny', 1, false)], 'x')?.id).toBe(
      'tiny'
    )
    expect(pickDefaultModel([model('free', 0, true), model('free2', 0, false)], 'x')?.id).toBe(
      'free'
    )
    expect(pickDefaultModel([model('other', 1, true, 'y')], 'x')).toBeUndefined()
  })

  it('redaction and the no-key-substring check', () => {
    const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
    const secrets = [key]
    const text = `error: invalid key ${key}; masked sk-proj-********wxyz; id req_011CS5002`
    const redacted = redact(text, secrets)
    expect(redacted).not.toContain(key)
    expect(redacted).not.toContain('sk-proj-')
    expect(redacted).toContain('req_011CS5002')
    expect(() => assertNoSecrets(redacted, secrets)).not.toThrow()

    // Any SECRET_WINDOW-character piece of a key is a leak; the error never repeats the key
    const piece = key.slice(10, 10 + SECRET_WINDOW)
    let message = ''
    try {
      assertNoSecrets(`partial ${piece} leak`, secrets)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/secret #1/)
    expect(message).not.toContain(piece)
    // A short secret must appear whole to count
    expect(() => assertNoSecrets('abc', ['abcd'])).not.toThrow()
    expect(() => assertNoSecrets('xabcdx', ['abcd'])).toThrow()
  })
})
