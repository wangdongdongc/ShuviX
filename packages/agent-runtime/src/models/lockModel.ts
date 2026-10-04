/**
 * The model an agent is created with (P1-09, ruling K5): a session's model selection resolved
 * against the provider rows and the model registry, at the moment the agent is created.
 *
 * A selection names a provider **row** (`sessions.settings.model.provider` is a row id, the same
 * id the pickers use) and a model id. The lock stores durable's ModelRef shape instead:
 * `{provider: <pi provider id>, modelId}` — the builtin slug for builtin rows, the row id for
 * custom rows (see `piProviderIdOf`; translated through `ModelRegistry.modelRefOf`, whose own
 * shape is `{provider, id}`).
 *
 * Refusals (nothing is created, the send returns `code: 'no_model'`):
 *  - `no_model` — there is no selection at all. Defaults (general.defaultProvider/Model) are the
 *    desktop config resolver's business and are applied before this; the runtime refuses when
 *    none is left.
 *  - `provider_unknown` — the row is gone. The text never shows the id (custom ids are uuids,
 *    meaningless to a person and, inside an error string, able to look like an HTTP status).
 *  - `provider_disabled` — the row's enabled bit is off, **read live** from the port (Q9: a
 *    disabled provider stays registered so locked sessions keep working; only creation refuses).
 *  - `model_unknown` — the provider does not offer that model.
 *
 * A disabled `provider_models` row is **not** a refusal: that bit is the picker's visibility flag,
 * not an availability statement (K5).
 */
import type { ModelRegistry } from './modelRegistry'
import { customProviderLabel, piProviderIdOf, type ProviderCredentialPort } from './port'

/** A session's model selection: provider row id + model id. */
export interface ModelSelection {
  provider: string
  modelId: string
}

/** The model a lock stores: durable's ModelRef shape (pi provider id + model id). */
export interface LockModel {
  provider: string
  modelId: string
}

export type LockModelRefusalKind =
  | 'no_model'
  | 'provider_unknown'
  | 'provider_disabled'
  | 'model_unknown'

export type LockModelResolution =
  | { readonly ok: true; readonly model: LockModel }
  | { readonly ok: false; readonly kind: LockModelRefusalKind; readonly message: string }

/** User-facing label of a provider row: display name, else name (never the row id). */
function providerLabel(row: { isBuiltin: boolean; name: string; displayName?: string }): string {
  if (!row.isBuiltin) return customProviderLabel(row)
  return row.displayName?.trim() || row.name?.trim() || 'provider'
}

function refuse(kind: LockModelRefusalKind, message: string): LockModelResolution {
  return { ok: false, kind, message }
}

/**
 * Resolve a selection to the model a new agent is locked to. Pure apart from reading the port's
 * rows and the registry's models (both live).
 */
export function resolveLockModel(
  registry: Pick<ModelRegistry, 'models' | 'modelRefOf'>,
  port: Pick<ProviderCredentialPort, 'listProviders'>,
  selection: ModelSelection | null | undefined
): LockModelResolution {
  const rowId = selection?.provider?.trim()
  const modelId = selection?.modelId?.trim()
  if (!selection || !rowId || !modelId) {
    return refuse(
      'no_model',
      'No model is selected for this session. Choose a model, or set a default model in settings.'
    )
  }
  const row = port.listProviders().find((candidate) => candidate.id === rowId)
  const ref = row ? registry.modelRefOf(row.id, modelId) : undefined
  if (!row || !ref || piProviderIdOf(row) === undefined) {
    return refuse(
      'provider_unknown',
      `The provider selected for model "${modelId}" no longer exists. Choose another model.`
    )
  }
  const label = providerLabel(row)
  if (!row.isEnabled) {
    return refuse(
      'provider_disabled',
      `Provider "${label}" is disabled, so model "${modelId}" cannot be used. Enable the provider in settings or choose another model.`
    )
  }
  if (registry.models.getModel(ref.provider, ref.id) === undefined) {
    return refuse(
      'model_unknown',
      `Model "${modelId}" is not available from provider "${label}". Choose another model.`
    )
  }
  return { ok: true, model: { provider: ref.provider, modelId: ref.id } }
}
