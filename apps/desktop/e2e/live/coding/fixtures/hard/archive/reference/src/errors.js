/** An error the caller can act on. `code` decides the HTTP status (see api/http.js). */
export class AppError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }
}

export const notFound = (what) => new AppError('NOT_FOUND', `${what} not found`)

export const invalid = (message, details = null) => new AppError('INVALID', message, details)

export const conflict = (message, details = null) => new AppError('CONFLICT', message, details)

export const archived = (sku) => new AppError('ARCHIVED', `item ${sku} is archived`, { sku })

export const insufficientStock = (sku, wanted, available) =>
  new AppError(
    'INSUFFICIENT_STOCK',
    `not enough stock for ${sku}: wanted ${wanted}, available ${available}`,
    { sku, wanted, available }
  )
