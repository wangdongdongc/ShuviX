import { invalid } from '../errors.js'

export const DAY_MS = 24 * 60 * 60 * 1000

/** A calendar date written as `YYYY-MM-DD` that exists (no 2026-02-30). */
export function isDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const date = new Date(`${text}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text
}

/** The `YYYY-MM-DD` that is `days` days after the (UTC) date of `date`. */
export function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10)
}

/** A Date from a user-supplied ISO string, or now. */
export function parseNow(text) {
  if (text === undefined || text === null || text === '') return new Date()
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) throw invalid(`bad date "${text}"`, { field: 'now' })
  return date
}
