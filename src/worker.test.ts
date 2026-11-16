// Runs src/worker.ts's activate(orca) over Orca's mock host, with Prisjakt replaced by fixtures.
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import { offerList, priceHistory, productPage, searchSuggestions } from './fixtures/index'
import { categoryFromHtml, productNameFromHtml } from './prisjakt'
import * as main from './worker'
import { notificationsFor, migrate } from './worker'
import type { TrackedItem } from './protocol'

type Call = { url: string; method: string; body?: string }
let calls: Call[] = []
let offers: unknown = offerList
let history: unknown = priceHistory

function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input)
  calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined })
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } })
  if (url.includes('/api/search-suggestions')) return Promise.resolve(json(searchSuggestions))
  if (url.includes('/api/price-history')) return Promise.resolve(json(history))
  if (url.includes('/api/offer-list/')) return Promise.resolve(json(offers))
  if (url.includes('/product.php')) return Promise.resolve(new Response(productPage, { status: 200, headers: { 'content-type': 'text/html' } }))
  if (url.includes('cdn.pji.nu')) return Promise.resolve(new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
  return Promise.resolve(new Response('nope', { status: 404 }))
}

main.setFetch(fakeFetch as typeof fetch)
afterEach(() => {
  calls = []
  offers = offerList
  history = priceHistory
})

const PRODUCT_URL = 'https://www.prisjakt.no/product.php?p=13083153'

test('adds a product from a pasted link with name, price and history', async () => {
  const host = mockHost({ settings: { market: 'www.prisjakt.no' } })
  const worker = await mountWorker(main, { host })
  const { item, existed } = await worker.request('item.add', { ref: PRODUCT_URL })
  assert.equal(existed, false)
  assert.equal(item.id, 13083153)
  assert.equal(item.host, 'www.prisjakt.no')
  assert.equal(item.name, 'Corsair Vengeance DDR5 6000MHz 2x16GB (CMK32GX5M2B6000Z30)')
  // HomeIT is cheapest but out of stock; CDON is the cheapest shop that has it.
  assert.equal(item.price, 7698)
  assert.equal(item.shop, 'CDON')
  assert.equal(item.inStock, 5)
  assert.ok(item.history.length > 5)
  assert.ok(item.history.every(([t, p]) => typeof t === 'number' && (p === null || p > 100)))
  const body = JSON.parse(calls.find((c) => c.url.endsWith('/api/price-history'))!.body!)
  assert.deepEqual(body, { productId: 13083153, timeRange: 'ALL', shopIds: [], variantIds: [] })

  const again = await worker.request('item.add', { ref: '13083153' })
  assert.equal(again.existed, true)
  const state = await worker.request('state.get')
  assert.equal(state.items.length, 1)
  assert.ok(worker.posts.some((p) => p.event === 'changed'))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('adding a search hit skips the page fetch', async () => {
  const worker = await mountWorker(main, { host: mockHost() })
  const hits = await worker.request('search', { query: 'rtx 5080' })
  assert.ok(hits.length >= 3)
  assert.ok(hits.every((h) => h.id && h.name && h.host === 'www.prisjakt.no'))
  calls = []
  await worker.request('item.add', { ref: String(hits[0].id), host: hits[0].host, name: hits[0].name, category: hits[0].category })
  assert.ok(!calls.some((c) => c.url.includes('product.php')))
  await worker.deactivate()
})

test('rejects links that are not Prisjakt products', async () => {
  const worker = await mountWorker(main, { host: mockHost() })
  await assert.rejects(() => worker.request('item.add', { ref: 'https://example.com/product.php?p=1' }))
  await worker.deactivate()
})

test('update, remove and restore', async () => {
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  const { item } = await worker.request('item.add', { ref: PRODUCT_URL })
  const updated = await worker.request('item.update', { id: item.id, host: item.host, patch: { target: 6999.5, pinned: true, note: 'for the new build', tags: ['pc', 'pc', ' '] } })
  assert.equal(updated.item.target, 6999.5)
  assert.equal(updated.item.pinned, true)
  assert.deepEqual(updated.item.tags, ['pc'])
  const { removed } = await worker.request('item.remove', { id: item.id, host: item.host })
  assert.ok(removed)
  assert.equal((await worker.request('state.get')).items.length, 0)
  await worker.request('item.restore', { item: removed! })
  const restored = (await worker.request('state.get')).items[0]
  assert.equal(restored.note, 'for the new build')
  await worker.deactivate()
})

test('a refresh records the drop, marks it unseen and notifies at target', async () => {
  const host = mockHost({ settings: { notifyTarget: true, notifyLowest: false, notifyAnyDrop: false } })
  const worker = await mountWorker(main, { host })
  const { item } = await worker.request('item.add', { ref: PRODUCT_URL })
  await worker.request('item.update', { id: item.id, host: item.host, patch: { target: 7000 } })
  // CDON drops its price to 6899.
  offers = (offerList as { shop: { name: string }; price: { amount: number } }[]).map((o) =>
    o.shop.name === 'CDON' ? { ...o, price: { ...o.price, amount: 6899 } } : o
  )
  const state = await worker.request('items.refresh', {})
  const after = state.items[0]
  assert.equal(after.price, 6899)
  assert.equal(after.prevPrice, 7698)
  assert.equal(after.seenPrice, 7698)
  assert.equal(host.callsOf('notifications.show').length, 1)
  // A second refresh at the same price never notifies again.
  await worker.request('items.refresh', {})
  assert.equal(host.callsOf('notifications.show').length, 1)
  await worker.request('items.seen', {})
  assert.equal((await worker.request('state.get')).items[0].seenPrice, 6899)
  assert.ok(host.callsOf('statusBar.update').length > 0)
  await worker.deactivate()
})

test('imports a backup and plain links', async () => {
  const worker = await mountWorker(main, { host: mockHost() })
  const { added } = await worker.request('items.import', {
    items: [{ id: 13083153, host: 'www.prisjakt.no', name: 'RAM', target: 5000, pinned: true }, 'https://www.prisjakt.no/product.php?p=13083153', 'not a link']
  })
  assert.equal(added, 1)
  const [item] = (await worker.request('state.get')).items
  assert.equal(item.target, 5000)
  assert.equal(item.pinned, true)
  await worker.deactivate()
})

test('thumbnails come back as data URLs and are cached for tracked items', async () => {
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  const { dataUrl } = await worker.request('image', { id: 13083153 })
  assert.ok(dataUrl?.startsWith('data:image/jpeg;base64,'))
  assert.equal(typeof host.data().storage['img:13083153'], 'string')
  await worker.request('image', { id: 42, cache: false })
  assert.equal(host.data().storage['img:42'], undefined)
  await worker.deactivate()
})

test('palette summary lists every item', async () => {
  const worker = await mountWorker(main, { host: mockHost() })
  assert.match(String(await worker.command('prisjakt.summary')), /No products/)
  await worker.request('item.add', { ref: PRODUCT_URL })
  assert.match(String(await worker.command('prisjakt.summary')), /Corsair Vengeance/)
  await worker.deactivate()
})

test('reads product names from the page payload', () => {
  assert.equal(productNameFromHtml(productPage), 'Corsair Vengeance DDR5 6000MHz 2x16GB (CMK32GX5M2B6000Z30)')
  assert.equal(productNameFromHtml('<meta property="og:title" content="Sony WH-1000XM5 - Black Friday: fra 2 990 kr"/>'), 'Sony WH-1000XM5')
  assert.equal(categoryFromHtml('<p>nothing</p>'), null)
})

test('notifications fire once per price and reset when the price goes back up', () => {
  const item = migrate({ id: 1, host: 'www.prisjakt.no', name: 'Thing', price: 900, target: 1000 } as TrackedItem)
  const opts = { notifyTarget: true, notifyLowest: true, notifyAnyDrop: true, threshold: 1 }
  assert.equal(notificationsFor(item, 1100, 950, opts).length, 1)
  assert.equal(notificationsFor(item, 900, 900, opts).length, 0)
  item.price = 1200
  notificationsFor(item, 900, 900, opts)
  assert.equal(item.notified.target, null)
  item.price = 950
  assert.equal(notificationsFor(item, 1200, 900, opts).length, 1)
})
