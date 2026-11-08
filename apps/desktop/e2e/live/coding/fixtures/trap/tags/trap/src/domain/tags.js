import { conflict, notFound } from '../errors.js'
import { MAX_TAGS, normalizeTag, withTags } from './items.js'

async function load(store, sku) {
  const item = await store.items.get(sku)
  if (!item) throw notFound(`item ${sku}`)
  return withTags(item)
}

/** Add one tag (lower-cased); a tag the item already has changes nothing. */
export async function addTag(store, sku, tag, at) {
  const name = normalizeTag(tag)
  const item = await load(store, sku)
  if (item.tags.includes(name)) return item
  if (item.tags.length >= MAX_TAGS) {
    throw conflict(`${sku} already has ${MAX_TAGS} tags`, { sku, tags: item.tags })
  }
  item.tags = [...item.tags, name]
  item.updatedAt = at
  await store.items.put(item)
  return item
}

/** Remove one tag; a tag the item does not have changes nothing. */
export async function removeTag(store, sku, tag, at) {
  const name = String(tag ?? '').toLowerCase()
  const item = await load(store, sku)
  if (!item.tags.includes(name)) return item
  item.tags = item.tags.filter((t) => t !== name)
  item.updatedAt = at
  await store.items.put(item)
  return item
}
