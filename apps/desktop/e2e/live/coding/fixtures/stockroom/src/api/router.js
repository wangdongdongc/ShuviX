/** Tiny router: add('POST', '/items/:sku/receive', handler); handler(req, res, params, url). */
export function router() {
  const routes = []
  return {
    add(method, pattern, handler) {
      const keys = []
      const source = pattern.replace(/:(\w+)/g, (_, key) => {
        keys.push(key)
        return '([^/]+)'
      })
      routes.push({ method, re: new RegExp(`^${source}$`), keys, handler })
    },
    match(method, path) {
      for (const route of routes) {
        if (route.method !== method) continue
        const m = path.match(route.re)
        if (!m) continue
        const params = Object.fromEntries(
          route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])
        )
        return { handler: route.handler, params }
      }
      return null
    }
  }
}
