// Prisjakt Tracker's worker: owns the tracked items, talks to Prisjakt, refreshes prices in the
// background, keeps the status bar item current and sends notifications. The panel only draws
// what `state.get` answers and asks for changes through the handlers below.
import type { OrcaWorkerApi } from 'orca/worker'
import {
  DEFAULT_HOST,
  MARKETS,
  extremes,
  formatPct,
  formatPrice,
  normalizeHost,
  parseRef,
  pct,
  seriesInRange,
  summarize,
  withObservation
} from '../panel/core.js'
import { createClient, PrisjaktError, type Client, type Fetch } from './prisjakt'
import type { Detail, ItemPatch, Offer, PricePoint, TrackedItem, TrackerState } from './protocol'

const ITEMS = 'items'
const LAST_REFRESH = 'lastRefresh'
const HIST = 'hist:'
const HOUR = 3_600_000
const MAX_ITEMS = 200
const GAP_MS = 700

export const keyOf = (item: { id: number; host: string }) => `${item.host}:${item.id}`

/** Tests swap the network out with `setFetch`; Orca never calls it. */
let fetchOverride: Fetch | null = null
export function setFetch(f: Fetch | null) {
  fetchOverride = f
}

export default function activate(orca: OrcaWorkerApi): void {
  const client: Client = createClient(fetchOverride ?? globalThis.fetch.bind(globalThis))
  let rev = 0
  let refreshing: Promise<void> | null = null
  let progress: { done: number; total: number } | null = null
  const offerCache = new Map<string, { at: number; offers: Offer[] }>()

  // --- storage, with every write serialized so two requests never lose each other's change ---
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn)
    queue = run.catch(() => undefined)
    return run
  }
  // Orca stores at most 256 KiB per key, so the list keeps only metadata and each product's
  // history lives under its own `hist:<host>:<id>` key. The worker is the only writer, so a
  // cache of what it last read or wrote is always current.
  const histCache = new Map<string, PricePoint[]>()
  async function historyOf(key: string): Promise<PricePoint[]> {
    const cached = histCache.get(key)
    if (cached) return cached
    const value = await orca.storage.get(HIST + key)
    const list = Array.isArray(value) ? (value as unknown as PricePoint[]) : []
    histCache.set(key, list)
    return list
  }
  async function loadItems(): Promise<TrackedItem[]> {
    const value = await orca.storage.get(ITEMS)
    const items = Array.isArray(value) ? (value as unknown as TrackedItem[]).map(migrate) : []
    await Promise.all(
      items.map(async (item) => {
        // Items written by 0.1.0 still carry their history inline: keep it, saveItems moves it out.
        if (!item.history.length) item.history = await historyOf(keyOf(item))
      })
    )
    return items
  }
  async function saveItems(items: TrackedItem[]) {
    const keep = new Set(items.map(keyOf))
    for (const item of items) {
      const key = keyOf(item)
      if (histCache.get(key) !== item.history) {
        await orca.storage.set(HIST + key, item.history as never)
        histCache.set(key, item.history)
      }
    }
    await orca.storage.set(ITEMS, items.map((item) => ({ ...item, history: [] })) as never)
    for (const key of [...histCache.keys()]) {
      if (!keep.has(key)) {
        histCache.delete(key)
        await orca.storage.delete(HIST + key).catch(() => undefined)
      }
    }
  }
  function mutate<T>(fn: (items: TrackedItem[]) => T | Promise<T>): Promise<T> {
    return serial(async () => {
      const items = await loadItems()
      const result = await fn(items)
      await saveItems(items)
      changed()
      return result
    })
  }

  async function setting<T>(key: string, fallback: T): Promise<T> {
    try {
      const v = await orca.settings.get(key)
      return v === undefined || v === null ? fallback : (v as T)
    } catch {
      return fallback
    }
  }

  function changed() {
    rev++
    orca.panels.post('changed', { rev, refreshing: !!refreshing, progress })
    void updateStatusBar()
  }

  async function state(): Promise<TrackerState> {
    const [items, lastRefresh, market, threshold] = await Promise.all([
      loadItems(),
      orca.storage.get(LAST_REFRESH),
      setting('market', DEFAULT_HOST),
      setting('dropThreshold', 1)
    ])
    return {
      // The list only needs the last year in detail; older points are thinned (keeping the
      // all-time low and high) so the answer stays small with hundreds of products.
      items: items.map((item) => ({ ...item, history: thinHistory(item.history) })),
      refreshing: !!refreshing,
      lastRefresh: typeof lastRefresh === 'number' ? lastRefresh : null,
      market: normalizeHost(market) ?? DEFAULT_HOST,
      threshold: Number(threshold) || 0
    }
  }

  // --- fetching one product ---
  async function fetchFresh(id: number, host: string) {
    const [history, offers] = await Promise.all([client.history(host, id, 'ALL'), client.offers(host, id).catch(() => [] as Offer[])])
    offerCache.set(`${host}:${id}`, { at: Date.now(), offers })
    const sellable = offers.filter((o) => !o.used)
    const inStock = sellable.filter((o) => o.stock === 'InStock')
    const notOut = sellable.filter((o) => o.stock !== 'OutOfStock')
    const lastHistory = history.length ? history[history.length - 1][1] : null
    const best = inStock[0] ?? notOut[0] ?? null
    const price = best?.price ?? lastHistory
    return {
      history: withObservation(history, Date.now(), price),
      offers,
      price,
      shop: best?.shop ?? null,
      inStock: inStock.length,
      offerCount: sellable.length
    }
  }

  function apply(item: TrackedItem, fresh: Awaited<ReturnType<typeof fetchFresh>>, now: number) {
    if (fresh.price !== item.price) {
      item.prevPrice = item.price
      item.changedAt = now
    }
    item.price = fresh.price
    item.shop = fresh.shop
    item.inStock = fresh.inStock
    item.offerCount = fresh.offerCount
    item.history = fresh.history
    item.checkedAt = now
    item.error = null
  }

  async function addItem(input: { ref: string; host?: string; name?: string; category?: string | null }) {
    const market = normalizeHost(input.host ?? (await setting('market', DEFAULT_HOST))) ?? DEFAULT_HOST
    const ref = parseRef(input.ref, market)
    if (!ref) {
      throw new PrisjaktError('Paste a Prisjakt product link (…/product.php?p=123) or search for a product', 'invalid_params')
    }
    const existing = (await loadItems()).find((i) => keyOf(i) === keyOf(ref))
    if (existing) return { item: existing, existed: true }
    if ((await loadItems()).length >= MAX_ITEMS) throw new PrisjaktError(`You can track up to ${MAX_ITEMS} products`, 'invalid_params')

    const [meta, fresh] = await Promise.all([
      input.name ? Promise.resolve({ name: input.name, category: input.category ?? null }) : client.meta(ref.host, ref.id),
      fetchFresh(ref.id, ref.host)
    ])
    const now = Date.now()
    const item: TrackedItem = {
      id: ref.id,
      host: ref.host,
      name: meta.name,
      category: meta.category,
      addedAt: now,
      addedPrice: fresh.price,
      price: fresh.price,
      shop: fresh.shop,
      inStock: fresh.inStock,
      offerCount: fresh.offerCount,
      history: fresh.history,
      target: null,
      pinned: false,
      note: '',
      tags: [],
      seenPrice: fresh.price,
      checkedAt: now,
      changedAt: null,
      prevPrice: null,
      error: null,
      notified: {}
    }
    return mutate((items) => {
      const again = items.find((i) => keyOf(i) === keyOf(item))
      if (again) return { item: again, existed: true }
      items.push(item)
      return { item, existed: false }
    })
  }

  // --- refreshing and notifying ---
  async function refreshAll(only?: { id: number; host: string }): Promise<void> {
    if (refreshing && !only) return refreshing
    const run = (async () => {
      const targets = (await loadItems()).filter((i) => !only || keyOf(i) === keyOf(only))
      progress = { done: 0, total: targets.length }
      changed()
      const notes: { title: string; body: string }[] = []
      const [notifyTarget, notifyLowest, notifyAnyDrop, threshold] = await Promise.all([
        setting('notifyTarget', true),
        setting('notifyLowest', true),
        setting('notifyAnyDrop', false),
        setting('dropThreshold', 1)
      ])
      for (const [index, target] of targets.entries()) {
        if (index > 0) await new Promise((r) => setTimeout(r, GAP_MS))
        let fresh: Awaited<ReturnType<typeof fetchFresh>> | null = null
        let error: string | null = null
        try {
          fresh = await fetchFresh(target.id, target.host)
        } catch (e) {
          error = (e as Error).message
        }
        await mutate((items) => {
          const item = items.find((i) => keyOf(i) === keyOf(target))
          if (!item) return
          const now = Date.now()
          if (!fresh) {
            item.error = error
            item.checkedAt = now
            return
          }
          const before = item.price
          const priorLow = extremes(seriesInRange(item.history, item.history[0]?.[0], now - 1)).low?.price ?? null
          apply(item, fresh, now)
          notes.push(...notificationsFor(item, before, priorLow, { notifyTarget, notifyLowest, notifyAnyDrop, threshold: Number(threshold) || 0 }))
        })
        progress = { done: index + 1, total: targets.length }
        changed()
      }
      if (!only) await orca.storage.set(LAST_REFRESH, Date.now())
      for (const n of notes.slice(0, 5)) {
        void orca.host.call('notifications.show', n).catch(() => undefined)
      }
      if (notes.length > 5) {
        void orca.host
          .call('notifications.show', { title: 'Prisjakt Tracker', body: `${notes.length - 5} more price updates — open the panel` })
          .catch(() => undefined)
      }
    })()
    if (!only) refreshing = run
    try {
      await run
    } finally {
      if (!only) refreshing = null
      progress = null
      changed()
    }
  }

  // --- status bar ---
  async function updateStatusBar() {
    try {
      const [items, threshold] = await Promise.all([loadItems(), setting('dropThreshold', 1)])
      const now = Date.now()
      const sums = items.map((i) => ({ i, s: summarize(i, now, { threshold: Number(threshold) || 0 }) }))
      const drops = sums.filter((x) => x.s.dropped)
      const atTarget = sums.filter((x) => x.s.atTarget)
      let text = items.length ? `${items.length} tracked` : 'Prices'
      let tone: 'neutral' | 'success' | 'accent' = 'neutral'
      if (atTarget.length) {
        text = `${atTarget.length} at target`
        tone = 'accent'
      }
      if (drops.length) {
        text = `▼ ${drops.length} price drop${drops.length === 1 ? '' : 's'}`
        tone = 'success'
      }
      const lines = [...drops, ...atTarget.filter((x) => !drops.includes(x))]
        .slice(0, 4)
        .map((x) => `${x.i.name.slice(0, 40)}: ${formatPrice(x.s.price, x.i.host)}${x.s.changeSeen ? ` (${formatPct(x.s.changeSeen)})` : ''}`)
      const tooltip = [lines.length ? lines.join('\n') : `${items.length} products tracked`, refreshing ? 'Refreshing…' : 'Click to refresh prices'].join('\n')
      await orca.host.call('statusBar.update', { id: 'drops', text, tone, tooltip, visible: true })
    } catch {
      /* the status bar is a nicety: never let it break a request */
    }
  }

  // --- background schedule: the worker stays up while the plugin is enabled (it has a status item) ---
  async function tick() {
    try {
      const items = await loadItems()
      if (!items.length || refreshing) return
      const hours = Math.max(1, Number(await setting('refreshHours', 4)) || 4)
      const last = await orca.storage.get(LAST_REFRESH)
      if (typeof last !== 'number' || Date.now() - last >= hours * HOUR) await refreshAll()
    } catch (e) {
      orca.log(`background refresh failed: ${(e as Error).message}`)
    }
  }
  const startTimer = setTimeout(tick, 8_000)
  const interval = setInterval(tick, 10 * 60_000)
  ;(startTimer as { unref?: () => void }).unref?.()
  ;(interval as { unref?: () => void }).unref?.()
  void updateStatusBar()
  orca.settings.onDidChange(() => {
    void updateStatusBar()
    orca.panels.post('changed', { rev: ++rev, refreshing: !!refreshing, progress })
  })

  // --- requests from the panel ---
  orca.panels.handle('state.get', () => state())

  orca.panels.handle('search', async ({ query, host }) => {
    const market = normalizeHost(host ?? (await setting('market', DEFAULT_HOST))) ?? DEFAULT_HOST
    return client.search(market, query)
  })

  orca.panels.handle('item.add', (input) => addItem(input))

  orca.panels.handle('item.remove', ({ id, host }) =>
    mutate((items) => {
      const index = items.findIndex((i) => keyOf(i) === keyOf({ id, host }))
      if (index < 0) return { removed: null }
      const [removed] = items.splice(index, 1)
      if (!items.some((i) => i.id === id)) void orca.storage.delete(`img:${id}`).catch(() => undefined)
      return { removed }
    })
  )

  orca.panels.handle('item.restore', ({ item }) =>
    mutate((items) => {
      const restored = migrate(item)
      if (!items.some((i) => keyOf(i) === keyOf(restored))) items.push(restored)
      return { ok: true as const }
    })
  )

  orca.panels.handle('item.update', ({ id, host, patch }) =>
    mutate((items) => {
      const item = items.find((i) => keyOf(i) === keyOf({ id, host }))
      if (!item) throw new PrisjaktError('That product is no longer tracked', 'invalid_params')
      applyPatch(item, patch)
      return { item }
    })
  )

  orca.panels.handle('item.detail', async ({ id, host }): Promise<Detail> => {
    const key = `${host}:${id}`
    const items = await loadItems()
    const item = items.find((i) => keyOf(i) === key)
    let cached = offerCache.get(key)
    if (!cached || Date.now() - cached.at > 10 * 60_000) {
      const offers = await client.offers(host, id)
      cached = { at: Date.now(), offers }
      offerCache.set(key, cached)
    }
    return { id, offers: cached.offers, history: item?.history ?? (await client.history(host, id)), fetchedAt: cached.at }
  })

  orca.panels.handle('items.refresh', async (input) => {
    const { id, host } = input ?? {}
    await refreshAll(id != null && host ? { id, host } : undefined)
    return state()
  })

  orca.panels.handle('items.seen', (input) =>
    mutate((items) => {
      const keys = input?.keys
      for (const item of items) if (!keys || keys.includes(keyOf(item))) item.seenPrice = item.price
      return { ok: true as const }
    })
  )

  orca.panels.handle('items.import', async ({ items: incoming }) => {
    const list = Array.isArray(incoming) ? incoming : Array.isArray((incoming as { items?: unknown })?.items) ? (incoming as { items: unknown[] }).items : []
    let added = 0
    for (const entry of list.slice(0, MAX_ITEMS)) {
      try {
        if (entry && typeof entry === 'object' && 'id' in entry && 'host' in entry) {
          const e = entry as Partial<TrackedItem>
          const host = normalizeHost(e.host) ?? DEFAULT_HOST
          const { existed } = await addItem({ ref: String(e.id), host, name: e.name, category: e.category ?? null })
          if (!existed) {
            added++
            await mutate((items) => {
              const item = items.find((i) => keyOf(i) === `${host}:${e.id}`)
              if (item) applyPatch(item, { target: e.target ?? null, pinned: !!e.pinned, note: e.note ?? '', tags: e.tags ?? [] })
            })
          }
        } else if (typeof entry === 'string' || typeof entry === 'number') {
          const { existed } = await addItem({ ref: String(entry) })
          if (!existed) added++
        }
      } catch (e) {
        orca.log(`import skipped ${JSON.stringify(entry).slice(0, 80)}: ${(e as Error).message}`)
      }
    }
    return { added }
  })

  const imageMemo = new Map<number, string | null>()
  orca.panels.handle('image', async ({ id, cache = true }) => {
    const key = `img:${id}`
    const stored = await orca.storage.get(key)
    if (typeof stored === 'string') return { dataUrl: stored }
    if (!cache && imageMemo.has(id)) return { dataUrl: imageMemo.get(id) ?? null }
    const dataUrl = await client.image(id)
    if (dataUrl && cache) await orca.storage.set(key, dataUrl)
    else {
      if (imageMemo.size > 200) imageMemo.clear()
      imageMemo.set(id, dataUrl)
    }
    return { dataUrl }
  })

  // --- palette commands ---
  orca.commands.register('prisjakt.refresh', async () => {
    const items = await loadItems()
    if (!items.length) return 'No products tracked yet. Open the Price Tracker panel in the right sidebar to add some.'
    await refreshAll()
    return summaryText(await loadItems())
  })
  orca.commands.register('prisjakt.summary', async () => summaryText(await loadItems()))

  function summaryText(items: TrackedItem[]) {
    if (!items.length) return 'No products tracked yet.'
    const now = Date.now()
    return items
      .map((i) => ({ i, s: summarize(i, now) }))
      .sort((a, b) => (a.s.change30 ?? 0) - (b.s.change30 ?? 0))
      .map(({ i, s }) => {
        const bits = [formatPrice(s.price, i.host)]
        if (s.change30) bits.push(`${formatPct(s.change30)} 30d`)
        if (s.atLow) bits.push('all-time low')
        if (s.atTarget) bits.push('at target')
        return `• ${i.name} — ${bits.join(', ')}`
      })
      .join('\n')
  }
}

export function notificationsFor(
  item: TrackedItem,
  before: number | null,
  priorLow: number | null,
  opts: { notifyTarget: boolean; notifyLowest: boolean; notifyAnyDrop: boolean; threshold: number }
): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = []
  const price = item.price
  item.notified ??= {}
  if (price == null) return out
  const name = item.name.length > 60 ? `${item.name.slice(0, 57)}…` : item.name
  const money = formatPrice(price, item.host)

  if (item.target != null) {
    if (price <= item.target) {
      if (opts.notifyTarget && item.notified.target !== price && (item.notified.target == null || price < item.notified.target)) {
        out.push({ title: `🎯 Target reached: ${money}`, body: `${name} is at or below your target of ${formatPrice(item.target, item.host)}` })
      }
      item.notified.target = Math.min(price, item.notified.target ?? Infinity)
    } else {
      item.notified.target = null
    }
  }
  const isNewLow = priorLow != null && price < priorLow
  if (isNewLow && opts.notifyLowest && item.notified.low !== price && !out.length) {
    out.push({ title: `📉 All-time low: ${money}`, body: `${name} has never been cheaper (was ${formatPrice(priorLow, item.host)})` })
    item.notified.low = price
  }
  const drop = pct(before, price)
  if (opts.notifyAnyDrop && drop != null && drop <= -Math.max(opts.threshold, 0.0001) && item.notified.drop !== price && !out.length) {
    out.push({ title: `▼ ${formatPct(drop)}: ${money}`, body: `${name} dropped from ${formatPrice(before, item.host)}` })
    item.notified.drop = price
  }
  return out
}

/** Keeps every point of the last `recentDays`, at most one a week before that, and always the extremes. */
export function thinHistory(history: PricePoint[], now = Date.now(), recentDays = 400): PricePoint[] {
  if (history.length <= 120) return history
  const cutoff = now - recentDays * 86_400_000
  let low: PricePoint | null = null
  let high: PricePoint | null = null
  for (const p of history) {
    if (p[1] == null) continue
    if (!low || p[1] < low[1]!) low = p
    if (!high || p[1] > high[1]!) high = p
  }
  const out: PricePoint[] = []
  let lastKept = -Infinity
  for (const p of history) {
    const keep = p[0] >= cutoff || p === low || p === high || p[0] - lastKept >= 7 * 86_400_000
    if (keep) {
      out.push(p)
      lastKept = p[0]
    }
  }
  return out
}

function applyPatch(item: TrackedItem, patch: ItemPatch) {
  if ('target' in patch) {
    const t = patch.target
    item.target = t == null || !Number.isFinite(Number(t)) || Number(t) <= 0 ? null : Math.round(Number(t) * 100) / 100
    item.notified = { ...item.notified, target: null }
  }
  if ('pinned' in patch) item.pinned = !!patch.pinned
  if ('note' in patch) item.note = String(patch.note ?? '').slice(0, 500)
  if ('tags' in patch) item.tags = [...new Set((patch.tags ?? []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 8)
  if ('name' in patch && patch.name && String(patch.name).trim()) item.name = String(patch.name).trim().slice(0, 200)
}

/** Fills in fields older stored items (or imported backups) may lack. */
export function migrate(raw: TrackedItem): TrackedItem {
  const host = normalizeHost(raw.host) ?? DEFAULT_HOST
  return {
    id: Number(raw.id),
    host: MARKETS[host as keyof typeof MARKETS] ? host : DEFAULT_HOST,
    name: String(raw.name ?? `Product ${raw.id}`),
    category: raw.category ?? null,
    addedAt: Number(raw.addedAt) || Date.now(),
    addedPrice: raw.addedPrice ?? raw.price ?? null,
    price: raw.price ?? null,
    shop: raw.shop ?? null,
    inStock: Number(raw.inStock) || 0,
    offerCount: Number(raw.offerCount) || 0,
    history: Array.isArray(raw.history) ? raw.history.filter((p) => Array.isArray(p) && p.length === 2) : [],
    target: raw.target ?? null,
    pinned: !!raw.pinned,
    note: String(raw.note ?? ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    seenPrice: raw.seenPrice ?? raw.price ?? null,
    checkedAt: Number(raw.checkedAt) || 0,
    changedAt: raw.changedAt ?? null,
    prevPrice: raw.prevPrice ?? null,
    error: raw.error ?? null,
    notified: raw.notified && typeof raw.notified === 'object' ? raw.notified : {}
  }
}
