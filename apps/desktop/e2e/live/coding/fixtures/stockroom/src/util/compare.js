/** Plain code-unit string order (not locale order), so sorting and cursor comparisons always agree. */
export function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}
