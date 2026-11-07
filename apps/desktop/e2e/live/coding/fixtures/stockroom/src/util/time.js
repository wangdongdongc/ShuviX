import { invalid } from '../errors.js'

export const DAY_MS = 24 * 60 * 60 * 1000

/** A Date from a user-supplied ISO string, or now. */
export function parseNow(text) {
  if (text === undefined || text === null || text === '') return new Date()
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) throw invalid(`bad date "${text}"`, { field: 'now' })
  return date
}
