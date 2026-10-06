/**
 * Env loader for the protocol probe (`protocols.probe.ts`, P4-06) — pure functions, unit-tested
 * by `src/main/services/models/__tests__/protocolProbe.guard.test.ts`.
 *
 * The probe's only inputs are `SHUVIX_PROBE_*` variables: from the process environment, or from a
 * dotenv-style file named by `SHUVIX_PROBE_ENV_FILE` (parsed with `node:util` `parseEnv`, no
 * dependency). Nothing else is read — no app data, no ambient provider variables
 * (`ANTHROPIC_API_KEY` and the like are ignored, and the probe's model registry gets an
 * `AuthContext` that answers nothing). A variable set in the process environment wins over the
 * same name in the file.
 *
 * Also here: the family table (§5 of the phase-4 plan), the default model choice, and the
 * redaction helpers that keep keys out of the report.
 */
import { parseEnv } from 'node:util'
import type { Api, Model } from '@earendil-works/pi-ai'

export const PROBE_PREFIX = 'SHUVIX_PROBE_'

/** Only `SHUVIX_PROBE_*` names survive; a name in `processEnv` overrides the file. */
export function collectProbeEnv(
  processEnv: Readonly<Record<string, string | undefined>>,
  fileText?: string
): Record<string, string> {
  const out: Record<string, string> = {}
  const take = (source: Readonly<Record<string, string | undefined>>): void => {
    for (const [name, value] of Object.entries(source)) {
      if (!name.startsWith(PROBE_PREFIX) || value === undefined) continue
      const trimmed = value.trim()
      if (trimmed !== '') out[name] = trimmed
    }
  }
  if (fileText !== undefined) take(parseEnv(fileText))
  take(processEnv)
  return out
}

/** Run-level knobs (not secrets). */
export interface ProbeOptions {
  dry: boolean
  maxUsd: number
  out: string
  envFile?: string
}

export function probeOptions(
  env: Readonly<Record<string, string>>,
  processEnv: Readonly<Record<string, string | undefined>>,
  defaultOut: string
): ProbeOptions {
  const max = Number(env.SHUVIX_PROBE_MAX_USD ?? '1')
  return {
    dry: isTruthy(env.SHUVIX_PROBE_DRY),
    maxUsd: Number.isFinite(max) && max > 0 ? max : 1,
    out: processEnv.PROBE_OUT?.trim() || defaultOut,
    ...(processEnv.SHUVIX_PROBE_ENV_FILE ? { envFile: processEnv.SHUVIX_PROBE_ENV_FILE } : {})
  }
}

export function isTruthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
}

// ─────────────────────────── families ───────────────────────────

/** How a family reaches its provider. */
export type FamilyTarget =
  | { kind: 'builtin'; slug: string }
  | {
      kind: 'custom'
      baseUrl: string
      protocol: string
      headers?: Record<string, string>
      vision: boolean
    }
  | { kind: 'faux' }

export interface FamilyConfig {
  id: string
  /** §5 family name */
  label: string
  /** The wire protocol this family is meant to cover (the model choice filters by it). */
  api: string
  target: FamilyTarget
  /** Env var names, for the report and the usage doc. */
  keyVar: string
  modelVar: string
  key?: string
  model?: string
  /** Why the family cannot run although a key may be set (bad config), shown in the report. */
  configError?: string
}

/** Providers accepted for the openai-completions family. */
export const COMPLETIONS_PROVIDERS = ['deepseek', 'groq', 'openrouter'] as const

/** The builtin families: id, label, pi slug, api, env stem. */
const BUILTIN_FAMILIES: readonly {
  id: string
  label: string
  slug: string
  api: string
  stem: string
}[] = [
  {
    id: 'anthropic',
    label: 'anthropic-messages',
    slug: 'anthropic',
    api: 'anthropic-messages',
    stem: 'ANTHROPIC'
  },
  {
    id: 'openai',
    label: 'openai-responses',
    slug: 'openai',
    api: 'openai-responses',
    stem: 'OPENAI'
  },
  {
    id: 'google',
    label: 'google-generative-ai',
    slug: 'google',
    api: 'google-generative-ai',
    stem: 'GOOGLE'
  },
  {
    id: 'mistral',
    label: 'mistral-conversations',
    slug: 'mistral',
    api: 'mistral-conversations',
    stem: 'MISTRAL'
  },
  { id: 'xai', label: 'xai (responses)', slug: 'xai', api: 'openai-responses', stem: 'XAI' },
  {
    id: 'kimi',
    label: 'Kimi UA check (kimi-coding)',
    slug: 'kimi-coding',
    api: 'anthropic-messages',
    stem: 'KIMI'
  }
]

export const CUSTOM_PROTOCOLS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
] as const

/** Every family the probe knows, in report order; keys present or not. */
export function resolveFamilies(env: Readonly<Record<string, string>>): FamilyConfig[] {
  const families: FamilyConfig[] = []
  const v = (name: string): string | undefined => env[`${PROBE_PREFIX}${name}`]

  for (const spec of BUILTIN_FAMILIES.slice(0, 2)) families.push(builtinFamily(spec, v))

  const completionsProvider = (v('COMPLETIONS_PROVIDER') ?? 'deepseek').toLowerCase()
  const knownCompletions = (COMPLETIONS_PROVIDERS as readonly string[]).includes(
    completionsProvider
  )
  families.push({
    id: 'completions',
    label: `openai-completions (${completionsProvider})`,
    api: 'openai-completions',
    target: { kind: 'builtin', slug: completionsProvider },
    keyVar: `${PROBE_PREFIX}COMPLETIONS_KEY`,
    modelVar: `${PROBE_PREFIX}COMPLETIONS_MODEL`,
    ...optional('key', v('COMPLETIONS_KEY')),
    ...optional('model', v('COMPLETIONS_MODEL')),
    ...(knownCompletions
      ? {}
      : {
          configError: `${PROBE_PREFIX}COMPLETIONS_PROVIDER must be one of ${COMPLETIONS_PROVIDERS.join(', ')}`
        })
  })

  for (const spec of BUILTIN_FAMILIES.slice(2)) families.push(builtinFamily(spec, v))

  const protocol = v('CUSTOM_PROTOCOL') ?? 'openai-completions'
  const baseUrl = v('CUSTOM_BASE_URL')
  const headersText = v('CUSTOM_HEADERS')
  let headers: Record<string, string> | undefined
  let configError: string | undefined
  if (headersText !== undefined) {
    headers = parseHeaders(headersText)
    if (headers === undefined) configError = `${PROBE_PREFIX}CUSTOM_HEADERS must be a JSON object`
  }
  if (!(CUSTOM_PROTOCOLS as readonly string[]).includes(protocol)) {
    configError = `${PROBE_PREFIX}CUSTOM_PROTOCOL must be one of ${CUSTOM_PROTOCOLS.join(', ')}`
  }
  if (v('CUSTOM_KEY') !== undefined && (baseUrl === undefined || !v('CUSTOM_MODEL'))) {
    configError = `${PROBE_PREFIX}CUSTOM_BASE_URL and ${PROBE_PREFIX}CUSTOM_MODEL are required with ${PROBE_PREFIX}CUSTOM_KEY`
  }
  families.push({
    id: 'custom',
    label: `custom endpoint (${protocol})`,
    api: protocol,
    target: {
      kind: 'custom',
      baseUrl: baseUrl ?? '',
      protocol,
      ...(headers ? { headers } : {}),
      vision: isTruthy(v('CUSTOM_VISION'))
    },
    keyVar: `${PROBE_PREFIX}CUSTOM_KEY`,
    modelVar: `${PROBE_PREFIX}CUSTOM_MODEL`,
    ...optional('key', v('CUSTOM_KEY')),
    ...optional('model', v('CUSTOM_MODEL')),
    ...(configError ? { configError } : {})
  })
  return families
}

function builtinFamily(
  spec: (typeof BUILTIN_FAMILIES)[number],
  v: (name: string) => string | undefined
): FamilyConfig {
  return {
    id: spec.id,
    label: spec.label,
    api: spec.api,
    target: { kind: 'builtin', slug: spec.slug },
    keyVar: `${PROBE_PREFIX}${spec.stem}_KEY`,
    modelVar: `${PROBE_PREFIX}${spec.stem}_MODEL`,
    ...optional('key', v(`${spec.stem}_KEY`)),
    ...optional('model', v(`${spec.stem}_MODEL`))
  }
}

function optional<K extends string>(
  name: K,
  value: string | undefined
): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [name]: value } as Record<K, string>)
}

function parseHeaders(text: string): Record<string, string> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') return undefined
      out[name] = value
    }
    return out
  } catch {
    return undefined
  }
}

/** A family runs when it has a key and no config error. */
export function familyRunnable(family: FamilyConfig): boolean {
  return family.key !== undefined && family.configError === undefined
}

/** Every env var name the probe reads, per family (the usage doc lists the same). */
export function familyEnvVars(family: FamilyConfig): string[] {
  if (family.id === 'completions') {
    return [`${PROBE_PREFIX}COMPLETIONS_PROVIDER`, family.keyVar, family.modelVar]
  }
  if (family.id === 'custom') {
    return [
      `${PROBE_PREFIX}CUSTOM_BASE_URL`,
      family.keyVar,
      family.modelVar,
      `${PROBE_PREFIX}CUSTOM_PROTOCOL`,
      `${PROBE_PREFIX}CUSTOM_HEADERS`,
      `${PROBE_PREFIX}CUSTOM_VISION`
    ]
  }
  return [family.keyVar, family.modelVar].filter((name) => name.startsWith(PROBE_PREFIX))
}

// ─────────────────────────── model choice ───────────────────────────

const priceOf = (model: Model<Api>): number => (model.cost?.input ?? 0) + (model.cost?.output ?? 0)

/**
 * The default model of a builtin family: among the provider's catalog models of the family's
 * api, the cheapest **priced** reasoning model (so assertion 4 has something to look at), else
 * the cheapest priced model, else the first one. A zero price usually means "unknown" (free
 * tiers are heavily rate-limited), so priced models win. Undefined = the provider offers no
 * model of that api.
 */
export function pickDefaultModel(
  models: readonly Model<Api>[],
  api: string
): Model<Api> | undefined {
  const candidates = models.filter((model) => model.api === api)
  const priced = candidates.filter((model) => priceOf(model) > 0)
  const cheapest = (list: readonly Model<Api>[]): Model<Api> | undefined =>
    [...list].sort((a, b) => priceOf(a) - priceOf(b))[0]
  return cheapest(priced.filter((model) => model.reasoning)) ?? cheapest(priced) ?? candidates[0]
}

export const modelIsPriced = (model: Model<Api>): boolean => priceOf(model) > 0

// ─────────────────────────── redaction ───────────────────────────

/** Every secret the run knows: keys and custom header values (≥ 4 chars; shorter is noise). */
export function secretsOf(families: readonly FamilyConfig[]): string[] {
  const secrets = new Set<string>()
  for (const family of families) {
    if (family.key) secrets.add(family.key)
    if (family.target.kind === 'custom') {
      for (const value of Object.values(family.target.headers ?? {})) secrets.add(value)
    }
  }
  return [...secrets].filter((secret) => secret.length >= 4)
}

/** Key-shaped tokens as providers echo them in error text (often masked: `sk-proj-****abcd`). */
const KEY_SHAPED =
  /\b(?:sk-|sk_|xai-|gsk_|AIza|ant-|key-|Bearer\s+)[A-Za-z0-9_\-*.]{6,}|\b[A-Za-z0-9_-]{32,}\b/g

/** Replace every known secret, and anything key-shaped, with a marker. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[redacted]')
  }
  return out.replace(KEY_SHAPED, '[redacted]')
}

/** The window used for the "no key substring" check. */
export const SECRET_WINDOW = 12

/**
 * Throws when `text` contains any secret, or any `SECRET_WINDOW`-character piece of one (the
 * whole secret when it is shorter). The message never repeats the secret.
 */
export function assertNoSecrets(text: string, secrets: readonly string[]): void {
  for (const [index, secret] of secrets.entries()) {
    const width = Math.min(SECRET_WINDOW, secret.length)
    for (let start = 0; start + width <= secret.length; start++) {
      if (text.includes(secret.slice(start, start + width))) {
        throw new Error(
          `report contains part of secret #${index + 1} (length ${secret.length}); not written`
        )
      }
    }
  }
}
