/**
 * Minimal argv parser: positionals, `--flag value`, `--flag=value` and bare `--flag` (true).
 * A flag followed by another flag, or by nothing, is boolean.
 */
export function parseArgs(argv) {
  const positionals = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[body] = argv[++i]
    } else {
      flags[body] = true
    }
  }
  return { positionals, flags }
}
