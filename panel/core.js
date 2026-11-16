// Pure helpers shared by the panel (panel/app.js) and the worker (src/worker.ts).
// No DOM, no network, no Orca APIs: everything here is unit-tested in panel/core.test.mjs.

/** @typedef {[number, number | null]} PricePoint  [epoch ms, lowest price in major units or null] */

export const DAY = 86_400_000

/** Every Prisjakt / PriceSpy site runs the same app, so one client works for all of them. */
export const MARKETS = {
  'www.prisjakt.no': { label: 'Prisjakt NO', currency: 'NOK', locale: 'nb-NO', path: 'product.php' },
  'www.prisjakt.nu': { label: 'Prisjakt SE', currency: 'SEK', locale: 'sv-SE', path: 'produkt.php' },
  'prisjagt.dk': { label: 'Prisjagt DK', currency: 'DKK', locale: 'da-DK', path: 'product.php' },
  'hintaopas.fi': { label: 'Hintaopas FI', currency: 'EUR', locale: 'fi-FI', path: 'product.php' },
  'pricespy.co.uk': { label: 'PriceSpy UK', currency: 'GBP', locale: 'en-GB', path: 'product.php' },
  'pricespy.co.nz': { label: 'PriceSpy NZ', currency: 'NZD', locale: 'en-NZ', path: 'product.php' }
}

export const DEFAULT_HOST = 'www.prisjakt.no'

/** Maps any spelling of a supported site (with or without www) to its MARKETS key. */
export function normalizeHost(host) {
  if (!host) return null
  const bare = String(host).toLowerCase().replace(/^www\./, '')
  for (const key of Object.keys(MARKETS)) {
    if (key.replace(/^www\./, '') === bare) return key
  }
  return null
}

/**
 * Reads a product reference out of what a person pastes: a product URL from any supported site
 * (product.php?p=…, produkt.php?p=…, /product/…-123 style paths), or a bare product id.
 * @returns {{ id: number, host: string } | null}
 */
export function parseRef(input, defaultHost = DEFAULT_HOST) {
  const text = String(input ?? '').trim()
  if (!text) return null
  if (/^\d{3,12}$/.test(text)) return { id: Number(text), host: normalizeHost(defaultHost) ?? DEFAULT_HOST }
  let url
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  const host = normalizeHost(url.hostname)
  if (!host) return null
  const p = url.searchParams.get('p') ?? url.searchParams.get('pu')
  if (p && /^\d+$/.test(p)) return { id: Number(p), host }
  const m = url.pathname.match(/(\d{4,12})(?:\/?$|[-_./])/)
  if (m) return { id: Number(m[1]), host }
  return null
}

export function productUrl(host, id) {
  const market = MARKETS[host] ?? MARKETS[DEFAULT_HOST]
  return `https://${host}/${market.path}?p=${id}`
}

export function imageUrl(id, size = 280) {
  return `https://cdn.pji.nu/product/standard/${size}/${id}.jpg`
}

const formatters = new Map()
/** "7 698 kr", "£449", … in the market's own locale; whole units unless the price has øre/pence. */
export function formatPrice(value, host = DEFAULT_HOST, { compact = false } = {}) {
  if (value == null || !Number.isFinite(value)) return '—'
  const market = MARKETS[host] ?? MARKETS[DEFAULT_HOST]
  const fraction = Math.round(value) !== value && !compact ? 2 : 0
  const key = `${host}|${fraction}|${compact}`
  let f = formatters.get(key)
  if (!f) {
    f = new Intl.NumberFormat(market.locale, {
      style: 'currency',
      currency: market.currency,
      maximumFractionDigits: fraction,
      minimumFractionDigits: fraction,
      notation: compact ? 'compact' : 'standard'
    })
    formatters.set(key, f)
  }
  return f.format(value)
}

/** Signed percent change from `from` to `to`, or null when either is missing. */
export function pct(from, to) {
  if (from == null || to == null || !from) return null
  return ((to - from) / from) * 100
}

export function formatPct(p, digits = 0) {
  if (p == null || !Number.isFinite(p)) return ''
  const rounded = Math.abs(p) < 10 && digits === 0 ? Math.round(p * 10) / 10 : Number(p.toFixed(digits))
  if (rounded === 0) return '0%'
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}%`
}

/**
 * Turns Prisjakt's history items (one per lowest-price change, price ×100) into sorted,
 * de-duplicated points. Items on the same day keep the last one.
 * @returns {PricePoint[]}
 */
export function historyFromApi(items) {
  /** @type {Map<number, number | null>} */
  const byDay = new Map()
  const sorted = [...(items ?? [])]
    .filter((x) => x && x.date)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
  for (const x of sorted) {
    const t = Date.parse(x.date)
    if (!Number.isFinite(t)) continue
    const price = typeof x.price === 'number' && x.price > 0 ? x.price / 100 : null
    byDay.set(startOfDay(t), price)
  }
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0])
  // Prisjakt history sometimes holds a listing error (a 3 000 kr headset "for" 140 kr). Drop
  // points far outside the product's usual range so lows, charts and alerts stay meaningful.
  const values = days.map(([, p]) => p).filter((p) => p != null).sort((a, b) => a - b)
  const median = values.length ? values[Math.floor(values.length / 2)] : null
  /** @type {PricePoint[]} */
  const out = []
  for (const [t, price] of days) {
    if (price != null && median != null && values.length >= 8 && (price < median * 0.3 || price > median * 4)) continue
    if (out.length && out[out.length - 1][1] === price) continue
    out.push([t, price])
  }
  return out
}

export function startOfDay(t) {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Price in effect at time t (the last point at or before t), or null. */
export function priceAt(history, t) {
  let found = null
  for (const [pt, price] of history ?? []) {
    if (pt <= t) found = price
    else break
  }
  return found
}

/** Appends today's observed price when it differs from the last point. Pure: returns a new array. */
export function withObservation(history, t, price) {
  const list = [...(history ?? [])]
  if (price == null) return list
  const last = list[list.length - 1]
  if (last && last[1] === price) return list
  const day = startOfDay(t)
  if (last && last[0] === day) list[list.length - 1] = [day, price]
  else list.push([day, price])
  return list
}

/**
 * The points needed to draw [from, now]: the price in effect at `from` as a first point, the
 * changes after it, and `now` carrying the current price so the line reaches the right edge.
 * @returns {PricePoint[]}
 */
export function seriesInRange(history, from, now = Date.now()) {
  const list = history ?? []
  /** @type {PricePoint[]} */
  const out = []
  const start = from ?? (list.length ? list[0][0] : now)
  const opening = priceAt(list, start)
  if (opening != null || list.some(([t]) => t <= start)) out.push([start, opening])
  for (const p of list) if (p[0] > start && p[0] <= now) out.push(p)
  const last = out[out.length - 1]
  if (last && last[0] < now) out.push([now, last[1]])
  return out
}

/** Lowest and highest non-null prices of a series, with when they happened. */
export function extremes(series) {
  let low = null
  let high = null
  for (const [t, price] of series ?? []) {
    if (price == null) continue
    if (!low || price < low.price) low = { price, t }
    if (!high || price > high.price) high = { price, t }
  }
  return { low, high }
}

/** Time-weighted average of a step series. */
export function average(series) {
  let sum = 0
  let span = 0
  for (let i = 0; i < series.length - 1; i++) {
    const [t, price] = series[i]
    const dt = series[i + 1][0] - t
    if (price == null || dt <= 0) continue
    sum += price * dt
    span += dt
  }
  if (!span) {
    const vals = series.map((p) => p[1]).filter((v) => v != null)
    return vals.length ? vals[vals.length - 1] : null
  }
  return sum / span
}

/**
 * Everything the list and the detail view show about one item, from its stored history.
 * @param {{ price: number | null, history: PricePoint[], addedPrice?: number | null, target?: number | null, seenPrice?: number | null }} item
 */
export function summarize(item, now = Date.now(), { threshold = 1 } = {}) {
  const history = item.history ?? []
  const price = item.price ?? (history.length ? history[history.length - 1][1] : null)
  const all = seriesInRange(history, history.length ? history[0][0] : now, now)
  const { low, high } = extremes(all)
  const month = priceAt(history, now - 30 * DAY)
  const change30 = pct(month, price)
  const changeAdded = pct(item.addedPrice ?? null, price)
  const changeSeen = pct(item.seenPrice ?? null, price)
  const atLow = price != null && low != null && price <= low.price + 0.005
  const atTarget = price != null && item.target != null && price <= item.target
  const toTarget = price != null && item.target != null ? pct(price, item.target) : null
  const fromLow = low && price != null ? pct(low.price, price) : null
  const dropped = changeSeen != null && changeSeen <= -Math.max(threshold, 0.0001)
  const year = extremes(seriesInRange(history, Math.max(now - 365 * DAY, history.length ? history[0][0] : now), now))
  return { price, low, high, year, change30, changeAdded, changeSeen, atLow, atTarget, toTarget, fromLow, dropped }
}

/** A short "Good price" / "High" style verdict from where the price sits between low and high. */
export function verdict(summary) {
  const { price } = summary
  // Judge against the last year: what a laptop cost in 2019 says little about today's deal.
  const low = summary.year?.low ?? summary.low
  const high = summary.year?.high ?? summary.high
  if (price == null || !low || !high) return null
  if (summary.atLow) return { label: 'All-time low', tone: 'good' }
  if (price <= low.price + 0.005) return { label: '1-year low', tone: 'good' }
  const span = high.price - low.price
  if (span <= 0) return null
  const pos = (price - low.price) / span
  if (pos <= 0.15) return { label: 'Near low', tone: 'good' }
  if (pos >= 0.8) return { label: 'Pricey', tone: 'warn' }
  return null
}

export const SORTS = {
  recent: 'Newest',
  drop: 'Biggest drop',
  target: 'Near target',
  priceAsc: 'Cheapest',
  priceDesc: 'Priciest',
  name: 'A–Z'
}

/** Sorts items for the list. Pinned items always come first. Returns a new array. */
export function sortItems(items, sort, now = Date.now()) {
  const withSummary = items.map((item) => ({ item, s: summarize(item, now) }))
  const key = {
    recent: (a, b) => b.item.addedAt - a.item.addedAt,
    name: (a, b) => a.item.name.localeCompare(b.item.name),
    priceAsc: (a, b) => (a.s.price ?? Infinity) - (b.s.price ?? Infinity),
    priceDesc: (a, b) => (b.s.price ?? -Infinity) - (a.s.price ?? -Infinity),
    drop: (a, b) => (a.s.change30 ?? 0) - (b.s.change30 ?? 0),
    target: (a, b) => (a.s.toTarget == null ? Infinity : -a.s.toTarget) - (b.s.toTarget == null ? Infinity : -b.s.toTarget)
  }[sort] ?? ((a, b) => b.item.addedAt - a.item.addedAt)
  return withSummary
    .sort((a, b) => Number(!!b.item.pinned) - Number(!!a.item.pinned) || key(a, b))
    .map((x) => x.item)
}

/** Case- and accent-insensitive match on name, category, note and tags. */
export function matches(item, query) {
  const q = fold(query)
  if (!q) return true
  const hay = fold([item.name, item.category, item.note, ...(item.tags ?? [])].filter(Boolean).join(' '))
  return q.split(/\s+/).every((word) => hay.includes(word))
}

export function fold(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .trim()
}

/**
 * SVG path data for a step chart of `series` scaled into width×height. Returns '' when there is
 * nothing to draw. `domain` lets several charts share one y-scale.
 */
export function stepPath(series, width, height, { from, to, min, max, pad = 2 } = {}) {
  const pts = (series ?? []).filter((p) => p[1] != null)
  if (pts.length === 0) return ''
  const x0 = from ?? series[0][0]
  const x1 = to ?? series[series.length - 1][0]
  const lo = min ?? Math.min(...pts.map((p) => p[1]))
  const hi = max ?? Math.max(...pts.map((p) => p[1]))
  const sx = (t) => (x1 === x0 ? width : ((t - x0) / (x1 - x0)) * width)
  const sy = (v) => (hi === lo ? height / 2 : pad + (1 - (v - lo) / (hi - lo)) * (height - pad * 2))
  let d = ''
  let prevY = null
  for (const [t, v] of series) {
    if (v == null) {
      prevY = null
      continue
    }
    const x = sx(t).toFixed(1)
    const y = sy(v).toFixed(1)
    if (prevY == null) d += `M${x},${y}`
    else d += `H${x}V${y}`
    prevY = y
  }
  return d
}

/** Rounded tick values for a y-axis between lo and hi. */
export function niceTicks(lo, hi, count = 4) {
  if (!(hi > lo)) return [lo]
  const raw = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const start = Math.ceil(lo / step) * step
  const ticks = []
  for (let v = start; v <= hi + 1e-9; v += step) ticks.push(Number(v.toFixed(6)))
  return ticks
}

export function relativeTime(t, now = Date.now()) {
  if (!t) return 'never'
  const s = Math.round((now - t) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} d ago`
  return new Date(t).toLocaleDateString()
}

export function shortDate(t, locale) {
  return new Date(t).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: '2-digit' })
}
