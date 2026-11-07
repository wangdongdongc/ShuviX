/**
 * Parse CSV text into rows (arrays of strings).
 * Lines are split on \n (a trailing \r is dropped), fields on commas. Blank lines are skipped.
 */
export function parseCsv(text) {
  const rows = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.trim() === '') continue
    rows.push(line.split(','))
  }
  return rows
}
