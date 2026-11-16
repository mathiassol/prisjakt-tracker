import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DAY,
  extremes,
  formatPct,
  formatPrice,
  historyFromApi,
  matches,
  niceTicks,
  parseRef,
  priceAt,
  seriesInRange,
  sortItems,
  stepPath,
  summarize,
  verdict,
  withObservation
} from './core.js'

test('parses links from every market, ids and junk', () => {
  assert.deepEqual(parseRef('https://www.prisjakt.no/product.php?p=13083153'), { id: 13083153, host: 'www.prisjakt.no' })
  assert.deepEqual(parseRef('prisjakt.no/product.php?p=13083153#statistics'), { id: 13083153, host: 'www.prisjakt.no' })
  assert.deepEqual(parseRef('https://www.prisjakt.nu/produkt.php?p=5512345'), { id: 5512345, host: 'www.prisjakt.nu' })
  assert.deepEqual(parseRef('https://pricespy.co.uk/product.php?pu=1234567'), { id: 1234567, host: 'pricespy.co.uk' })
  assert.deepEqual(parseRef('https://prisjagt.dk/product/sony-wh-1000xm5-6061234'), { id: 6061234, host: 'prisjagt.dk' })
  assert.deepEqual(parseRef('  13083153 ', 'pricespy.co.uk'), { id: 13083153, host: 'pricespy.co.uk' })
  assert.equal(parseRef('https://example.com/product.php?p=1'), null)
  assert.equal(parseRef('sony headphones'), null)
  assert.equal(parseRef(''), null)
})

test('formats prices in the market currency', () => {
  assert.match(formatPrice(7698, 'www.prisjakt.no'), /^7\s698\skr$/)
  assert.match(formatPrice(449, 'pricespy.co.uk'), /^£449$/)
  assert.equal(formatPrice(null), '—')
  assert.equal(formatPct(-4.23), '−4.2%')
  assert.equal(formatPct(12.6), '+13%')
})

test('turns API history into de-duplicated daily points', () => {
  const h = historyFromApi([
    { date: '2026-01-02T23:00:00Z', price: 500000 },
    { date: '2026-01-01T23:00:00Z', price: 500000 },
    { date: '2026-01-05T23:00:00Z', price: 450000 },
    { date: '2026-01-05T23:30:00Z', price: 440000 },
    { date: '2026-01-07T23:00:00Z', price: null }
  ])
  assert.deepEqual(h.map((p) => p[1]), [5000, 4400, null])
})

const T0 = Date.UTC(2026, 0, 1)
const hist = [
  [T0, 1000],
  [T0 + 10 * DAY, 800],
  [T0 + 40 * DAY, 900],
  [T0 + 70 * DAY, 850]
]

test('step series, extremes and price lookup', () => {
  assert.equal(priceAt(hist, T0 + 5 * DAY), 1000)
  assert.equal(priceAt(hist, T0 - 1), null)
  const s = seriesInRange(hist, T0 + 20 * DAY, T0 + 80 * DAY)
  assert.deepEqual(s[0], [T0 + 20 * DAY, 800])
  assert.deepEqual(s[s.length - 1], [T0 + 80 * DAY, 850])
  assert.deepEqual(extremes(s).low, { price: 800, t: T0 + 20 * DAY })
  const d = stepPath(s, 100, 20)
  assert.match(d, /^M0\.0,/)
  assert.ok(d.includes('H'))
})

test('observations append or replace the last day', () => {
  assert.equal(withObservation(hist, T0 + 90 * DAY, 850).length, 4)
  const next = withObservation(hist, T0 + 90 * DAY, 799)
  assert.equal(next.length, 5)
  assert.equal(next[4][1], 799)
  assert.equal(hist.length, 4)
})

test('summary flags drops, lows and targets', () => {
  const now = T0 + 80 * DAY
  const item = { name: 'X', price: 790, history: withObservation(hist, now, 790), addedPrice: 1000, seenPrice: 850, target: 800 }
  const s = summarize(item, now)
  assert.equal(s.atLow, true)
  assert.equal(s.atTarget, true)
  assert.equal(s.dropped, true)
  assert.equal(Math.round(s.changeAdded), -21)
  assert.deepEqual(verdict(s), { label: 'All-time low', tone: 'good' })
  const high = summarize({ ...item, price: 990, history: withObservation(hist, now, 990) }, now)
  assert.equal(verdict(high).tone, 'warn')
})

test('sorting keeps pinned items first', () => {
  const now = T0 + 80 * DAY
  const items = [
    { name: 'b', price: 100, history: [], addedAt: 1 },
    { name: 'a', price: 300, history: [], addedAt: 2, pinned: true },
    { name: 'c', price: 200, history: [], addedAt: 3 }
  ]
  assert.deepEqual(sortItems(items, 'priceAsc', now).map((i) => i.name), ['a', 'b', 'c'])
  assert.deepEqual(sortItems(items, 'recent', now).map((i) => i.name), ['a', 'c', 'b'])
})

test('search matching ignores case and Nordic letters', () => {
  assert.ok(matches({ name: 'Elkjøp Bærbar PC', tags: ['gave'] }, 'baerbar pc'))
  assert.equal(matches({ name: 'Sony WH-1000XM5' }, 'bose'), false)
  assert.ok(matches({ name: 'Sony WH-1000XM5' }, 'sony 1000xm5'))
})

test('axis ticks are round numbers', () => {
  assert.deepEqual(niceTicks(5800, 7400, 4), [6000, 6500, 7000])
})

test('drops listing-error outliers from history', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i * 3)).toISOString(), price: (3500 + i * 10) * 100 }))
  items.splice(5, 0, { date: new Date(Date.UTC(2026, 0, 14, 12)).toISOString(), price: 14000 })
  const h = historyFromApi(items)
  assert.ok(h.every(([, p]) => p > 1000))
})
