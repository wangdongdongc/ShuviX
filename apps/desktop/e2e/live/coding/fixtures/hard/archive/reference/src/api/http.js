import { AppError, invalid } from '../errors.js'

/** AppError code → HTTP status */
const STATUS = {
  INVALID: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INSUFFICIENT_STOCK: 409,
  ARCHIVED: 409
}

export async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw invalid('request body is not valid JSON')
  }
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text)
  })
  res.end(text)
}

export function sendError(res, err) {
  if (err instanceof AppError) {
    sendJson(res, STATUS[err.code] ?? 500, {
      error: { code: err.code, message: err.message, details: err.details ?? null }
    })
    return
  }
  console.error(err)
  sendJson(res, 500, { error: { code: 'INTERNAL', message: 'internal error', details: null } })
}

/** A positive integer query parameter, or undefined when absent. */
export function intParam(url, name) {
  const text = url.searchParams.get(name)
  if (text === null) return undefined
  const n = Number(text)
  if (!Number.isInteger(n) || n < 1) throw invalid(`${name} must be a positive integer`)
  return n
}
