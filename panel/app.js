// Prisjakt Tracker panel. Draws what the worker's `state.get` answers; every change goes through
// orca.plugin.request so the worker stays the single owner of the data.
import {
  DAY,
  MARKETS,
  SORTS,
  average,
  extremes,
  fold,
  formatPct,
  formatPrice,
  matches,
  niceTicks,
  parseRef,
  pct,
  priceAt,
  productUrl,
  relativeTime,
  seriesInRange,
  shortDate,
  sortItems,
  stepPath,
  summarize,
  verdict
} from './core.js'

const $ = (id) => document.getElementById(id)
const keyOf = (item) => `${item.host}:${item.id}`
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const RANGES = [
  ['1M', 30],
  ['3M', 91],
  ['6M', 182],
  ['1Y', 365],
  ['2Y', 730],
  ['All', null]
]

const prefs = loadPrefs()
const ui = {
  state: null,
  loading: true,
  detailKey: null,
  offers: new Map(), // key -> { offers, fetchedAt } | { error }
  showAllOffers: false,
  images: new Map(), // id -> dataUrl | null | 'pending'
  search: { q: '', hits: [], local: [], sel: 0, loading: false, seq: 0, error: null, open: false },
  kbd: -1,
  flash: null,
  pendingRender: false
}

// ---------------------------------------------------------------- worker bridge
function request(name, input, opts) {
  return orca.plugin.request(name, input, { timeoutMs: 60_000, ...opts })
}

async function loadState() {
  try {
    ui.state = await request('state.get')
    ui.loading = false
    render()
  } catch (e) {
    ui.loading = false
    renderError(e)
  }
}

let changedTimer = null
orca.plugin.on('changed', (payload) => {
  if (ui.state) {
    ui.state.refreshing = payload.refreshing
    renderProgress(payload.progress)
  }
  clearTimeout(changedTimer)
  changedTimer = setTimeout(loadState, 120)
})

// ---------------------------------------------------------------- prefs (per viewer, best effort)
function loadPrefs() {
  const base = { filter: 'all', sort: 'recent', compact: false, range: '6M' }
  try {
    return { ...base, ...JSON.parse(localStorage.getItem('prisjakt-tracker:prefs') || '{}') }
  } catch {
    return base
  }
}
function savePrefs() {
  try {
    localStorage.setItem('prisjakt-tracker:prefs', JSON.stringify(prefs))
  } catch {
    /* private frame: prefs just reset next time */
  }
}

// ---------------------------------------------------------------- images
function thumbStyle(id) {
  const url = ui.images.get(id)
  if (url && url !== 'pending') return ` style="background-image:url('${url}')"`
  return ''
}
function thumbClass(id) {
  const url = ui.images.get(id)
  return url && url !== 'pending' ? 'thumb' : 'thumb empty'
}
async function ensureImage(id, cache = true) {
  if (ui.images.has(id)) return
  ui.images.set(id, 'pending')
  try {
    const { dataUrl } = await request('image', { id, cache })
    ui.images.set(id, dataUrl)
  } catch {
    ui.images.set(id, null)
  }
  for (const el of document.querySelectorAll(`[data-img="${id}"]`)) {
    const url = ui.images.get(id)
    if (url) {
      el.style.backgroundImage = `url('${url}')`
      el.classList.remove('empty')
    } else el.classList.remove('empty')
  }
}

// ---------------------------------------------------------------- list
function visibleItems() {
  const s = ui.state
  if (!s) return []
  const now = Date.now()
  const opts = { threshold: s.threshold }
  let items = sortItems(s.items, prefs.sort, now)
  if (prefs.filter !== 'all') {
    items = items.filter((item) => {
      const sum = summarize(item, now, opts)
      if (prefs.filter === 'drops') return sum.dropped || (sum.change30 != null && sum.change30 <= -Math.max(s.threshold, 0.0001))
      if (prefs.filter === 'target') return item.target != null
      if (prefs.filter === 'low') return sum.atLow || verdict(sum)?.tone === 'good'
      return true
    })
  }
  return items
}

function counts() {
  const s = ui.state
  const now = Date.now()
  const out = { all: s.items.length, drops: 0, target: 0, low: 0 }
  for (const item of s.items) {
    const sum = summarize(item, now, { threshold: s.threshold })
    if (sum.dropped || (sum.change30 != null && sum.change30 <= -Math.max(s.threshold, 0.0001))) out.drops++
    if (item.target != null) out.target++
    if (sum.atLow || verdict(sum)?.tone === 'good') out.low++
  }
  return out
}

function render() {
  if (!ui.state) return
  document.body.classList.toggle('compact', !!prefs.compact)
  renderToolbar()
  renderItems()
  renderFoot()
  $('refresh-btn').classList.toggle('spinning', !!ui.state.refreshing)
  if (ui.detailKey) renderDetailSoon()
  if (ui.search.open) renderSuggestions()
}

function renderToolbar() {
  const s = ui.state
  $('toolbar').hidden = s.items.length === 0
  const c = counts()
  for (const el of document.querySelectorAll('[data-count]')) {
    const n = c[el.dataset.count]
    el.textContent = el.dataset.count === 'all' ? String(n || '') : n ? String(n) : ''
  }
  for (const chip of document.querySelectorAll('.chip')) chip.setAttribute('aria-selected', String(chip.dataset.filter === prefs.filter))
  const sort = $('sort')
  if (!sort.options.length) {
    sort.innerHTML = Object.entries(SORTS)
      .map(([v, label]) => `<option value="${v}">${esc(label)}</option>`)
      .join('')
  }
  sort.value = prefs.sort
  const menuDensity = document.querySelector('[data-action="density"]')
  menuDensity.textContent = prefs.compact ? 'Comfortable cards' : 'Compact rows'
}

function renderItems() {
  const s = ui.state
  const host = $('items')
  const note = $('filter-note')
  if (ui.loading) {
    host.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>'
    return
  }
  if (s.items.length === 0) {
    note.hidden = true
    host.innerHTML = emptyState()
    return
  }
  const items = visibleItems()
  if (items.length === 0) {
    const what = { drops: 'price drops', target: 'items with a target price', low: 'items at or near their lowest price' }[prefs.filter]
    note.hidden = true
    host.innerHTML = `<div class="empty"><h2>No ${esc(what)} right now</h2><p>${
      prefs.filter === 'target' ? 'Open an item and set a target price to get notified when it gets there.' : 'Check back after the next refresh.'
    }</p><button class="btn small" data-filter-reset>Show all ${s.items.length}</button></div>`
    return
  }
  note.hidden = true
  const now = Date.now()
  host.innerHTML = items.map((item, i) => card(item, summarize(item, now, { threshold: s.threshold }), i)).join('')
  for (const item of items) void ensureImage(item.id)
  if (ui.flash) {
    const el = host.querySelector(`[data-key="${CSS.escape(ui.flash)}"]`)
    if (el) {
      el.scrollIntoView({ block: 'nearest' })
      el.animate?.([{ background: 'color-mix(in srgb, var(--accent) 22%, var(--card))' }, { background: 'var(--card)' }], { duration: 1400, easing: 'ease-out' })
    }
    ui.flash = null
  }
}

function card(item, sum, index) {
  const key = keyOf(item)
  const v = verdict(sum)
  const unseen = sum.dropped
  const deltaVal = unseen ? sum.changeSeen : sum.change30
  const deltaTitle = unseen ? 'Since you last looked' : 'Last 30 days'
  const delta =
    deltaVal == null || Math.abs(deltaVal) < 0.05
      ? ''
      : `<span class="delta ${deltaVal < 0 ? 'down' : 'up'}" title="${deltaTitle}">${deltaVal < 0 ? '▼' : '▲'} ${esc(formatPct(Math.abs(deltaVal)).replace('+', ''))}</span>`
  // One status tag at most, so the row never has to squeeze it.
  let tag = ''
  if (item.error) tag = `<span class="tag bad" title="${esc(item.error)}">Update failed</span>`
  else if (sum.atTarget) tag = '<span class="tag accent">At target</span>'
  else if (item.price != null && item.offerCount && item.inStock === 0) tag = '<span class="tag warn">Out of stock</span>'
  else if (v) tag = `<span class="tag ${v.tone}">${esc(v.label)}</span>`
  const metaBits = []
  if (sum.low && !sum.atLow) metaBits.push(`<span class="fix">Lowest ${esc(formatPrice(sum.low.price, item.host))}</span>`)
  if (item.shop) metaBits.push(`<span class="shrink">${esc(item.shop)}</span>`)
  const meta = `${tag}${metaBits.join('<span class="dot">·</span>')}`
  let target = ''
  if (item.target != null && sum.price != null) {
    const ratio = Math.max(0, Math.min(1, item.target / sum.price))
    const left = sum.atTarget ? 'Reached' : `${formatPct(Math.abs(sum.toTarget)).replace('+', '')} to go`
    target = `<div class="target-row${sum.atTarget ? ' hit' : ''}">
      <span class="fix">Target ${esc(formatPrice(item.target, item.host))}</span>
      <div class="target-track"><div class="fill" style="width:${(ratio * 100).toFixed(1)}%"></div></div>
      <span class="fix">${esc(left)}</span>
    </div>`
  }
  return `<button class="card${unseen ? ' unseen' : ''}${index === ui.kbd ? ' kbd' : ''}" data-key="${esc(key)}" data-index="${index}" aria-label="${esc(item.name)}, ${esc(formatPrice(sum.price, item.host))}">
    <div class="${thumbClass(item.id)}" data-img="${item.id}"${thumbStyle(item.id)}></div>
    <div class="body">
      <div class="title-row">
        <div class="title">${esc(item.name)}</div>
        ${item.pinned ? '<span class="pin" title="Pinned"><svg viewBox="0 0 16 16"><path d="M9.5 2.5 13.5 6.5 11 8 10.5 11 5 5.5 8 5z"/></svg></span>' : ''}
      </div>
      <div class="price-row">
        <span class="price">${esc(formatPrice(sum.price, item.host))}</span>
        ${delta}
        ${sparkline(item)}
      </div>
      ${meta ? `<div class="meta">${meta}</div>` : ''}
      ${target}
    </div>
  </button>`
}

function sparkline(item) {
  const now = Date.now()
  const series = seriesInRange(item.history, now - 90 * DAY, now)
  const vals = series.map((p) => p[1]).filter((v) => v != null)
  if (vals.length < 2) return '<svg class="spark" viewBox="0 0 100 26" preserveAspectRatio="none"></svg>'
  const first = vals[0]
  const last = vals[vals.length - 1]
  const color = last < first ? 'var(--good)' : last > first ? 'var(--bad)' : 'var(--muted)'
  const d = stepPath(series, 100, 26, { from: now - 90 * DAY, to: now, pad: 3 })
  const area = d ? `${d}V26H${d.match(/^M([\d.]+)/)?.[1] ?? 0}Z` : ''
  return `<svg class="spark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
    <path class="area" d="${area}" fill="${color}" opacity=".12"/>
    <path class="line" d="${d}" stroke="${color}" vector-effect="non-scaling-stroke"/>
  </svg>`
}

function emptyState() {
  return `<div class="empty">
    <svg class="art" viewBox="0 0 64 40"><path d="M4 30 L18 18 L28 24 L42 8 L60 14"/><path d="M42 8 v24" opacity=".35"/></svg>
    <h2>Track prices from Prisjakt</h2>
    <p>Search above, or paste a product link.</p>
    <ul>
      <li>Type a product name and pick it from the list</li>
      <li>Or paste <code>prisjakt.no/product.php?p=…</code> and press <kbd>Enter</kbd></li>
      <li>Set a target price and get notified when it drops</li>
      <li>Press <kbd>/</kbd> anytime to search</li>
    </ul>
  </div>`
}

function renderFoot() {
  const s = ui.state
  $('foot').hidden = s.items.length === 0
  $('updated').textContent = s.refreshing ? 'Updating prices…' : `Updated ${relativeTime(s.lastRefresh ?? newestCheck())}`
  $('total').textContent = `${s.items.length} product${s.items.length === 1 ? '' : 's'} · ${MARKETS[s.market]?.label ?? s.market}`
}
function newestCheck() {
  return Math.max(0, ...ui.state.items.map((i) => i.checkedAt || 0)) || null
}

function renderProgress(progress) {
  const bar = $('progress')
  if (!progress || !progress.total) {
    bar.hidden = true
    return
  }
  bar.hidden = false
  bar.firstElementChild.style.width = `${Math.round((progress.done / progress.total) * 100)}%`
  $('refresh-btn').classList.add('spinning')
}

function renderError(e) {
  $('items').innerHTML = `<div class="empty"><h2>Could not load your list</h2><p>${esc(e?.message ?? e)}</p><button class="btn small" id="retry">Try again</button></div>`
  $('retry')?.addEventListener('click', loadState)
}

// ---------------------------------------------------------------- search
let searchTimer = null
function onSearchInput() {
  const q = $('search-input').value
  ui.search.q = q
  $('search-clear').hidden = !q
  $('search-hint').hidden = !!q
  ui.search.sel = 0
  ui.search.error = null
  const trimmed = q.trim()
  ui.search.local = trimmed && ui.state ? ui.state.items.filter((i) => matches(i, trimmed)).slice(0, 4) : []
  clearTimeout(searchTimer)
  if (!trimmed) {
    closeSuggestions()
    return
  }
  ui.search.open = true
  const ref = looksLikeLink(trimmed) ? parseRef(trimmed, ui.state?.market) : null
  if (ref || looksLikeLink(trimmed)) {
    ui.search.hits = []
    ui.search.loading = false
    renderSuggestions()
    return
  }
  if (trimmed.length < 2) {
    ui.search.hits = []
    renderSuggestions()
    return
  }
  ui.search.loading = true
  renderSuggestions()
  const seq = ++ui.search.seq
  searchTimer = setTimeout(async () => {
    try {
      const hits = await request('search', { query: trimmed }, { timeoutMs: 20_000 })
      if (seq !== ui.search.seq) return
      ui.search.hits = hits.slice(0, 8)
      for (const h of ui.search.hits) void ensureImage(h.id, false)
    } catch (e) {
      if (seq !== ui.search.seq) return
      ui.search.hits = []
      ui.search.error = e?.message ?? String(e)
    }
    ui.search.loading = false
    renderSuggestions()
  }, 220)
}

function looksLikeLink(text) {
  return /^https?:\/\//i.test(text) || /(prisjakt|prisjagt|pricespy|hintaopas)\./i.test(text) || /^\d{5,12}$/.test(text)
}

function options() {
  const q = ui.search.q.trim()
  const out = []
  if (looksLikeLink(q)) {
    const ref = parseRef(q, ui.state?.market)
    out.push({ kind: 'paste', ref })
  }
  for (const item of ui.search.local) out.push({ kind: 'local', item })
  const tracked = new Set((ui.state?.items ?? []).map(keyOf))
  const shown = new Set(ui.search.local.map(keyOf))
  for (const hit of ui.search.hits) if (!shown.has(keyOf(hit))) out.push({ kind: 'hit', hit, tracked: tracked.has(keyOf(hit)) })
  return out
}

function renderSuggestions() {
  const box = $('suggestions')
  if (!ui.search.open) {
    box.hidden = true
    return
  }
  const opts = options()
  ui.search.sel = Math.min(ui.search.sel, Math.max(0, opts.length - 1))
  const parts = []
  let i = 0
  const sel = (n) => (n === ui.search.sel ? 'true' : 'false')
  const paste = opts.find((o) => o.kind === 'paste')
  if (paste) {
    const ref = paste.ref
    const tracked = ref && ui.state?.items.some((x) => keyOf(x) === keyOf(ref))
    parts.push(
      ref
        ? `<button class="sugg-paste" role="option" data-opt="${i}" aria-selected="${sel(i)}"><span class="plus">${tracked ? '✓' : '+'}</span><span><b>${
            tracked ? 'Already tracking this product' : 'Track this product'
          }</b><br><span class="muted">#${ref.id} on ${esc(MARKETS[ref.host]?.label ?? ref.host)} · Enter</span></span></button>`
        : `<div class="sugg-empty">That link is not a Prisjakt product page.<br>Try a link like prisjakt.no/product.php?p=123</div>`
    )
    if (ref) i++
  }
  const locals = opts.filter((o) => o.kind === 'local')
  if (locals.length) {
    parts.push('<div class="sugg-head"><span>In your list</span></div>')
    for (const o of locals) {
      const sum = summarize(o.item)
      parts.push(`<button class="sugg" role="option" data-opt="${i}" aria-selected="${sel(i)}">
        <div class="${thumbClass(o.item.id)}" data-img="${o.item.id}"${thumbStyle(o.item.id)}></div>
        <div style="min-width:0"><div class="name">${esc(o.item.name)}</div><div class="cat">${esc(o.item.category ?? '')}</div></div>
        <div class="right"><div class="price">${esc(formatPrice(sum.price, o.item.host))}</div><div class="tracked">Tracking</div></div></button>`)
      i++
    }
  }
  const hits = opts.filter((o) => o.kind === 'hit')
  if (hits.length || ui.search.loading || ui.search.error) {
    parts.push(`<div class="sugg-head"><span>On ${esc(MARKETS[ui.state?.market]?.label ?? 'Prisjakt')}</span><span>${ui.search.loading ? 'Searching…' : ''}</span></div>`)
  }
  for (const o of hits) {
    const h = o.hit
    parts.push(`<button class="sugg" role="option" data-opt="${i}" aria-selected="${sel(i)}">
      <div class="${thumbClass(h.id)}" data-img="${h.id}"${thumbStyle(h.id)}></div>
      <div style="min-width:0"><div class="name">${esc(h.name)}</div><div class="cat">${esc(h.category ?? '')}</div></div>
      <div class="right"><div class="price">${esc(formatPrice(h.price, h.host))}</div>${o.tracked ? '<div class="tracked">✓ Tracking</div>' : ''}</div></button>`)
    i++
  }
  if (ui.search.error) parts.push(`<div class="sugg-empty">${esc(ui.search.error)}</div>`)
  else if (!paste && !ui.search.loading && !hits.length && !locals.length && ui.search.q.trim().length >= 2) {
    parts.push('<div class="sugg-empty">No products found. Try fewer words, or paste a link.</div>')
  }
  box.innerHTML = parts.join('')
  box.hidden = parts.length === 0
  box.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
}

function closeSuggestions() {
  ui.search.open = false
  ui.search.hits = []
  ui.search.local = []
  ui.search.loading = false
  ui.search.seq++
  $('suggestions').hidden = true
}

function clearSearch() {
  $('search-input').value = ''
  onSearchInput()
}

async function choose(index, { openDetail = false } = {}) {
  const opt = options()[index]
  if (!opt) return
  if (opt.kind === 'local') {
    clearSearch()
    $('search-input').blur()
    openItem(keyOf(opt.item))
    return
  }
  if (opt.kind === 'paste') {
    if (!opt.ref) return
    const existing = ui.state?.items.find((x) => keyOf(x) === keyOf(opt.ref))
    clearSearch()
    if (existing) return openItem(keyOf(existing))
    return add({ ref: String(opt.ref.id), host: opt.ref.host }, openDetail)
  }
  if (opt.kind === 'hit') {
    const h = opt.hit
    clearSearch()
    if (opt.tracked) return openItem(keyOf(h))
    if (ui.images.get(h.id) && ui.images.get(h.id) !== 'pending') {
      // keep the thumbnail we already have; the worker caches its own copy on first request
      ui.images.delete(h.id)
    }
    return add({ ref: String(h.id), host: h.host, name: h.name, category: h.category }, openDetail)
  }
}

async function add(input, openDetail) {
  toast('Adding…', { sticky: true })
  try {
    const { item, existed } = await request('item.add', input)
    ui.flash = keyOf(item)
    await loadState()
    toast(existed ? 'Already tracking that one' : `Tracking ${shorten(item.name, 40)}`, {
      action: 'View',
      onAction: () => openItem(keyOf(item))
    })
    if (openDetail) openItem(keyOf(item))
  } catch (e) {
    toast(e?.message ?? 'Could not add that product', { error: true })
  }
}

// ---------------------------------------------------------------- detail
function currentItem() {
  return ui.state?.items.find((i) => keyOf(i) === ui.detailKey) ?? null
}

function openItem(key) {
  ui.detailKey = key
  ui.showAllOffers = false
  $('list-view').hidden = true
  $('detail-view').hidden = false
  $('detail').scrollTop = 0
  renderDetail()
  const item = currentItem()
  if (item) {
    void loadOffers(item)
    void ensureImage(item.id)
    if (item.seenPrice !== item.price) void request('items.seen', { keys: [key] }).catch(() => undefined)
  }
  $('detail').focus({ preventScroll: true })
}

function closeDetail() {
  const key = ui.detailKey
  ui.detailKey = null
  $('detail-view').hidden = true
  $('list-view').hidden = false
  render()
  const el = document.querySelector(`.card[data-key="${CSS.escape(key ?? '')}"]`)
  el?.focus({ preventScroll: false })
}

async function loadOffers(item, force = false) {
  const key = keyOf(item)
  if (!force && ui.offers.has(key) && !ui.offers.get(key).error && Date.now() - ui.offers.get(key).fetchedAt < 5 * 60_000) return
  try {
    const d = await request('item.detail', { id: item.id, host: item.host })
    ui.offers.set(key, { offers: d.offers, fetchedAt: d.fetchedAt })
  } catch (e) {
    ui.offers.set(key, { error: e?.message ?? String(e), fetchedAt: Date.now() })
  }
  if (ui.detailKey === key) renderDetailSection('offers')
}

let detailQueued = false
function renderDetailSoon() {
  // Never re-render under the person's cursor in the target or note fields.
  const active = document.activeElement
  if (active && $('detail').contains(active) && /INPUT|TEXTAREA/.test(active.tagName)) {
    detailQueued = true
    return
  }
  renderDetail()
}

function renderDetail() {
  detailQueued = false
  const item = currentItem()
  const host = $('detail')
  if (!item) {
    host.innerHTML = '<div class="empty"><h2>No longer tracked</h2><button class="btn small" id="detail-back">Back to list</button></div>'
    $('detail-back')?.addEventListener('click', closeDetail)
    return
  }
  const now = Date.now()
  const sum = summarize(item, now, { threshold: ui.state.threshold })
  const v = verdict(sum)
  const market = MARKETS[item.host]
  $('pin-btn').classList.toggle('active', !!item.pinned)
  $('pin-btn').title = item.pinned ? 'Unpin (P)' : 'Pin to top (P)'
  const delta30 = sum.change30 == null || Math.abs(sum.change30) < 0.05 ? '' : `<span class="delta ${sum.change30 < 0 ? 'down' : 'up'}" title="Last 30 days">${sum.change30 < 0 ? '▼' : '▲'} ${esc(formatPct(Math.abs(sum.change30)).replace('+', ''))} 30d</span>`
  const subBits = []
  if (item.shop) subBits.push(`Cheapest at <b>${esc(item.shop)}</b>`)
  if (item.offerCount) subBits.push(`${item.inStock} of ${item.offerCount} shops in stock`)
  subBits.push(`checked ${relativeTime(item.checkedAt, now)}`)

  host.innerHTML = `
    <div class="hero">
      <div class="${thumbClass(item.id)}" data-img="${item.id}"${thumbStyle(item.id)}></div>
      <div style="min-width:0">
        <h1>${esc(item.name)}</h1>
        <div class="cat">${esc([item.category, market?.label].filter(Boolean).join(' · '))}</div>
      </div>
    </div>
    <div class="big-price"><span class="price">${esc(formatPrice(sum.price, item.host))}</span>${delta30}${v ? `<span class="tag ${v.tone}">${esc(v.label)}</span>` : ''}${
      sum.atTarget ? '<span class="tag accent">At target</span>' : ''
    }</div>
    <div class="sub">${subBits.join(' · ')}${item.error ? `<div class="error-line">Last update failed: ${esc(item.error)}</div>` : ''}</div>

    <div class="ranges" role="group" aria-label="Range">
      ${RANGES.map(([label]) => `<button data-range="${label}" aria-pressed="${label === prefs.range}">${label}</button>`).join('')}
    </div>
    <div class="chart" id="chart"></div>
    <div class="stats" id="stats"></div>

    <div class="section">
      <h2>Target price ${item.target != null ? '<button class="link" id="target-clear" style="font-size:11px;text-transform:none;letter-spacing:0">Clear</button>' : ''}</h2>
      <form class="target-box" id="target-form">
        <label class="money-input">
          <span class="sr">Target price</span>
          <input id="target-input" inputmode="decimal" autocomplete="off" placeholder="Notify me at…" value="${item.target ?? ''}" />
          <span class="unit">${esc(market?.currency ?? '')}</span>
        </label>
        <button class="btn" type="submit">Set</button>
      </form>
      <div class="quick" id="quick">
        ${sum.price != null ? [5, 10, 20].map((p) => `<button class="btn small" data-quick="${p}">−${p}%</button>`).join('') : ''}
        ${sum.low && sum.price != null && sum.low.price < sum.price ? `<button class="btn small" data-quick="low">Lowest ever (${esc(formatPrice(sum.low.price, item.host))})</button>` : ''}
      </div>
      <div class="target-hint">${targetHint(item, sum)}</div>
    </div>

    <div class="section" id="offers-section"></div>

    <div class="section">
      <h2>Note</h2>
      <textarea class="note" id="note" rows="2" maxlength="500" placeholder="Why you're watching this, size, colour…">${esc(item.note)}</textarea>
    </div>

    <div class="section muted" style="font-size:11px">
      Tracking since ${esc(shortDate(item.addedAt))}${item.addedPrice != null ? ` at ${esc(formatPrice(item.addedPrice, item.host))}` : ''} · #${item.id}
      · <button class="link" id="refresh-one" style="font-size:11px">Refresh now</button>
    </div>`
  renderDetailSection('chart')
  renderDetailSection('offers')
}

function targetHint(item, sum) {
  if (item.target == null) return 'Set a target and you will get a notification when any shop reaches it.'
  if (sum.atTarget) return `<span class="tag accent">Reached</span> The price is ${esc(formatPrice(item.target - sum.price, item.host))} under your target.`
  const need = sum.price - item.target
  const lowNote =
    sum.low && sum.low.price <= item.target ? ` It was this cheap on ${esc(shortDate(sum.low.t))}.` : sum.low ? ` Never been this low (lowest ${esc(formatPrice(sum.low.price, item.host))}).` : ''
  return `${esc(formatPrice(need, item.host))} (${esc(formatPct(Math.abs(sum.toTarget)).replace('+', ''))}) to go.${lowNote}`
}

function renderDetailSection(which) {
  const item = currentItem()
  if (!item) return
  if (which === 'chart') {
    const chartEl = $('chart')
    if (chartEl) drawChart(chartEl, item)
  }
  if (which === 'offers') {
    const el = $('offers-section')
    if (!el) return
    const data = ui.offers.get(keyOf(item))
    if (!data) {
      el.innerHTML = '<h2>Shops</h2><div class="offers"><div class="offer-skel" style="border:0"></div><div class="offer-skel"></div><div class="offer-skel"></div></div>'
      return
    }
    if (data.error) {
      el.innerHTML = `<h2>Shops</h2><div class="error-line">${esc(data.error)} <button class="link" id="offers-retry">Retry</button></div>`
      return
    }
    // In-stock first (cheapest first), then backorder, then out of stock: the cheapest you can buy leads.
    const rank = (o) => (o.stock === 'InStock' ? 0 : o.stock === 'OutOfStock' ? 2 : 1) + (o.used ? 0.5 : 0)
    const offers = [...data.offers].sort((a, b) => rank(a) - rank(b) || a.price - b.price)
    if (!offers.length) {
      el.innerHTML = '<h2>Shops</h2><div class="muted">No shop sells this right now.</div>'
      return
    }
    const shown = ui.showAllOffers ? offers : offers.slice(0, 6)
    const bestPrice = Math.min(...offers.filter((o) => o.stock === 'InStock' && !o.used).map((o) => o.price))
    el.innerHTML = `<h2><span>Shops (${offers.length})</span><span style="text-transform:none;letter-spacing:0;font-weight:400">${esc(relativeTime(data.fetchedAt))}</span></h2>
      <div class="offers">${shown
        .map((o, i) => {
          const cls = o.stock === 'InStock' ? 'in' : o.stock === 'OutOfStock' ? 'out' : /Back|Incoming|Order/i.test(o.stock) ? 'back' : ''
          const label = { InStock: 'In stock', OutOfStock: 'Out of stock', Backorder: 'Backorder', Incoming: 'Incoming' }[o.stock] ?? o.stock
          const ship = o.shipping === 0 ? 'Free shipping' : o.shipping != null ? `+${formatPrice(o.shipping, item.host)} shipping` : ''
          return `<button class="offer${o.price === bestPrice && o.stock === 'InStock' && !o.used ? ' best' : ''}${o.stock === 'OutOfStock' ? ' gone' : ''}" data-offer="${data.offers.indexOf(o)}" title="${esc(label)}${o.used ? ' · Used' : ''} — open ${esc(o.shop)}">
            <span class="stock ${cls}"></span>
            <span class="shop">${esc(o.shop)}${o.used ? ' <span class="tag warn">Used</span>' : ''}</span>
            <span class="ship">${esc(ship)}</span>
            <span class="p">${esc(formatPrice(o.price, item.host))}</span>
          </button>`
        })
        .join('')}
        ${offers.length > 6 ? `<button class="more" id="more-offers">${ui.showAllOffers ? 'Show fewer' : `Show all ${offers.length} shops`}</button>` : ''}
      </div>`
  }
}

// ---------------------------------------------------------------- chart
function rangeStart(item, now) {
  const days = RANGES.find(([l]) => l === prefs.range)?.[1]
  if (days == null) return item.history.length ? item.history[0][0] : now - 30 * DAY
  return now - days * DAY
}

function drawChart(el, item) {
  const now = Date.now()
  const from = Math.max(rangeStart(item, now), item.history.length ? item.history[0][0] : -Infinity)
  const series = seriesInRange(item.history, from, now)
  const values = series.map((p) => p[1]).filter((v) => v != null)
  const statsEl = $('stats')
  if (values.length === 0) {
    el.innerHTML = '<div class="chart-empty">No price history yet</div>'
    if (statsEl) statsEl.innerHTML = ''
    return
  }
  const W = Math.max(200, el.clientWidth || 300)
  const H = 170
  const left = 4
  const right = 46
  const top = 10
  const bottom = 18
  const iw = W - left - right
  const ih = H - top - bottom
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (item.target != null && item.target < lo && item.target > lo * 0.6) lo = item.target
  if (item.target != null && item.target > hi && item.target < hi * 1.4) hi = item.target
  if (hi === lo) {
    hi = hi * 1.05 + 1
    lo = lo * 0.95
  }
  const padY = (hi - lo) * 0.08
  lo -= padY
  hi += padY
  const sx = (t) => left + ((t - from) / Math.max(1, now - from)) * iw
  const sy = (v) => top + (1 - (v - lo) / (hi - lo)) * ih
  const d = stepPath(series, iw, ih, { from, to: now, min: lo, max: hi, pad: 0 })
  const ticks = niceTicks(lo, hi, 4)
  const { low, high } = extremes(series)
  const firstX = d.match(/^M([\d.]+)/)?.[1] ?? 0
  const area = d ? `${d}V${ih}H${firstX}Z` : ''
  const xLabels = timeLabels(from, now, iw)
  const targetY = item.target != null && item.target >= lo && item.target <= hi ? sy(item.target) : null

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price history">
    <defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    <g class="grid">${ticks
      .map((t) => `<line x1="${left}" x2="${left + iw}" y1="${sy(t).toFixed(1)}" y2="${sy(t).toFixed(1)}"/><text x="${W - right + 6}" y="${(sy(t) + 3).toFixed(1)}">${esc(formatPrice(t, item.host, { compact: t >= 10000 }))}</text>`)
      .join('')}</g>
    <g class="axis">${xLabels.map(([t, label]) => `<text x="${sx(t).toFixed(1)}" y="${H - 4}" text-anchor="middle">${esc(label)}</text>`).join('')}</g>
    <g transform="translate(${left},${top})"><path class="area" d="${area}"/><path class="line" d="${d}"/></g>
    ${targetY != null ? `<line class="target-line" x1="${left}" x2="${left + iw}" y1="${targetY.toFixed(1)}" y2="${targetY.toFixed(1)}"/><text class="target-label" x="${left + 4}" y="${(targetY - 4).toFixed(1)}">Target</text>` : ''}
    ${low ? `<circle class="low-dot" cx="${sx(low.t).toFixed(1)}" cy="${sy(low.price).toFixed(1)}" r="3.5"><title>Lowest ${esc(formatPrice(low.price, item.host))} · ${esc(shortDate(low.t))}</title></circle>` : ''}
    <line class="cross" id="cross" y1="${top}" y2="${top + ih}" visibility="hidden"/>
    <circle class="hover-dot" id="hover-dot" r="3.5" visibility="hidden"/>
    <rect id="hit" x="${left}" y="0" width="${iw}" height="${H}" fill="transparent"/>
  </svg><div class="tip" id="tip" hidden></div>`

  const svg = el.querySelector('svg')
  const tip = el.querySelector('#tip')
  const cross = el.querySelector('#cross')
  const dot = el.querySelector('#hover-dot')
  const move = (ev) => {
    const rect = svg.getBoundingClientRect()
    const x = ((ev.clientX - rect.left) / rect.width) * W
    const t = from + ((x - left) / iw) * (now - from)
    if (t < from || t > now) return hide()
    const price = priceAt(series, t)
    if (price == null) return hide()
    const px = sx(t)
    cross.setAttribute('x1', px)
    cross.setAttribute('x2', px)
    cross.setAttribute('visibility', 'visible')
    dot.setAttribute('cx', px)
    dot.setAttribute('cy', sy(price))
    dot.setAttribute('visibility', 'visible')
    tip.hidden = false
    tip.innerHTML = `<b>${esc(formatPrice(price, item.host))}</b> <span class="muted">${esc(shortDate(t))}</span>`
    const tw = tip.offsetWidth
    tip.style.left = `${Math.min(Math.max((px / W) * rect.width, tw / 2), rect.width - tw / 2)}px`
  }
  const hide = () => {
    tip.hidden = true
    cross.setAttribute('visibility', 'hidden')
    dot.setAttribute('visibility', 'hidden')
  }
  svg.addEventListener('pointermove', move)
  svg.addEventListener('pointerleave', hide)

  if (statsEl) {
    const avg = average(series)
    const price = item.price ?? values[values.length - 1]
    const sinceAdded = pct(item.addedPrice, price)
    const allLow = extremes(seriesInRange(item.history, item.history[0]?.[0], now)).low
    statsEl.innerHTML = [
      stat('Lowest', low && formatPrice(low.price, item.host), low && shortDate(low.t)),
      stat('Highest', high && formatPrice(high.price, item.host), high && shortDate(high.t)),
      stat('Average', avg != null && formatPrice(Math.round(avg), item.host), avg != null && price != null ? `now ${formatPct(pct(avg, price)) || '±0%'} vs avg` : ''),
      prefs.range !== 'All' && allLow
        ? stat('All-time low', formatPrice(allLow.price, item.host), shortDate(allLow.t))
        : stat('Since added', sinceAdded == null ? '—' : formatPct(sinceAdded) || '0%', shortDate(item.addedAt))
    ].join('')
  }
}

function stat(k, v, s) {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v || '—')}</div><div class="s">${esc(s || '')}</div></div>`
}

function timeLabels(from, to, width) {
  const span = to - from
  const count = Math.max(2, Math.min(5, Math.floor(width / 70)))
  const out = []
  for (let i = 0; i <= count; i++) {
    if (i === 0 || i === count) continue
    const t = from + (span * i) / count
    const d = new Date(t)
    const label = span > 400 * DAY ? d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    out.push([t, label])
  }
  return out
}

// ---------------------------------------------------------------- actions
async function update(item, patch, message) {
  try {
    await request('item.update', { id: item.id, host: item.host, patch })
    await loadState()
    if (message) toast(message)
  } catch (e) {
    toast(e?.message ?? 'Could not save', { error: true })
  }
}

async function removeItem(item) {
  try {
    const { removed } = await request('item.remove', { id: item.id, host: item.host })
    if (ui.detailKey === keyOf(item)) closeDetail()
    await loadState()
    toast(`Stopped tracking ${shorten(item.name, 32)}`, {
      action: 'Undo',
      duration: 7000,
      onAction: async () => {
        if (!removed) return
        await request('item.restore', { item: removed })
        ui.flash = keyOf(removed)
        ui.images.delete(removed.id)
        await loadState()
      }
    })
  } catch (e) {
    toast(e?.message ?? 'Could not remove', { error: true })
  }
}

async function refresh(item) {
  if (ui.state?.refreshing && !item) return toast('Already refreshing…')
  $('refresh-btn').classList.add('spinning')
  try {
    await request('items.refresh', item ? { id: item.id, host: item.host } : {}, { timeoutMs: 120_000 })
    if (item) {
      await loadOffers(item, true)
      toast('Price updated')
    }
  } catch (e) {
    toast(e?.message ?? 'Refresh failed', { error: true })
  } finally {
    await loadState()
  }
}

async function openExternal(url) {
  try {
    if (orca.shell?.openExternal) await orca.shell.openExternal(url)
    else window.open(url, '_blank', 'noopener')
  } catch (e) {
    toast(e?.message ?? 'Could not open the link', { error: true })
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('Link copied')
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.append(ta)
    ta.select()
    const ok = document.execCommand?.('copy')
    ta.remove()
    toast(ok ? 'Link copied' : text)
  }
}

async function saveFile(name, mimeType, data) {
  if (!orca.files?.saveAs) return toast('Saving files needs the Orca desktop app', { error: true })
  try {
    const { status } = await orca.files.saveAs({ suggestedName: name, mimeType, data })
    if (status === 'saved') toast(`Saved ${name}`)
  } catch (e) {
    toast(e?.message ?? 'Could not save', { error: true })
  }
}

function exportJson() {
  const items = ui.state.items.map(({ id, host, name, category, target, pinned, note, tags, addedAt, addedPrice }) => ({
    id, host, name, category, target, pinned, note, tags, addedAt, addedPrice, url: productUrl(host, id)
  }))
  const date = new Date().toISOString().slice(0, 10)
  return saveFile(`prisjakt-tracker-${date}.json`, 'application/json', JSON.stringify({ app: 'prisjakt-tracker', version: 1, items }, null, 2))
}

function exportCsv() {
  const now = Date.now()
  const rows = [['Name', 'Price', 'Currency', 'Cheapest shop', 'Lowest ever', 'Highest ever', 'Change 30d %', 'Target', 'In stock', 'Category', 'Link']]
  for (const item of ui.state.items) {
    const s = summarize(item, now)
    rows.push([
      item.name, s.price ?? '', MARKETS[item.host]?.currency ?? '', item.shop ?? '', s.low?.price ?? '', s.high?.price ?? '',
      s.change30 == null ? '' : s.change30.toFixed(1), item.target ?? '', `${item.inStock}/${item.offerCount}`, item.category ?? '', productUrl(item.host, item.id)
    ])
  }
  const csv = rows.map((r) => r.map((c) => (/[",\n;]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\n')
  return saveFile(`prisjakt-prices-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', `﻿${csv}`)
}

// bulk add / import sheet
function openSheet(mode) {
  $('sheet-title').textContent = mode === 'import' ? 'Import backup' : 'Add several products'
  $('sheet-text').textContent =
    mode === 'import'
      ? 'Paste the contents of a Prisjakt Tracker backup (.json). Links or ids one per line work too.'
      : 'Paste Prisjakt links or product ids, one per line.'
  $('sheet-input').value = ''
  $('sheet-input').placeholder = mode === 'import' ? '{ "app": "prisjakt-tracker", "items": [ … ] }' : 'https://www.prisjakt.no/product.php?p=13083153\nhttps://www.prisjakt.no/product.php?p=14365241'
  $('sheet-ok').textContent = mode === 'import' ? 'Import' : 'Add all'
  $('sheet').hidden = false
  $('sheet-backdrop').hidden = false
  $('sheet-input').focus()
}
function closeSheet() {
  $('sheet').hidden = true
  $('sheet-backdrop').hidden = true
}
async function submitSheet() {
  const text = $('sheet-input').value.trim()
  if (!text) return closeSheet()
  let items
  try {
    const parsed = JSON.parse(text)
    items = Array.isArray(parsed) ? parsed : parsed.items
  } catch {
    items = text
      .split(/[\n,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => parseRef(s, ui.state?.market))
  }
  if (!Array.isArray(items) || !items.length) return toast('Nothing to add in that text', { error: true })
  closeSheet()
  toast(`Adding ${items.length} product${items.length === 1 ? '' : 's'}…`, { sticky: true })
  try {
    const { added } = await request('items.import', { items }, { timeoutMs: 120_000 })
    await loadState()
    toast(added ? `Added ${added} product${added === 1 ? '' : 's'}` : 'All of them were already tracked')
  } catch (e) {
    toast(e?.message ?? 'Import failed', { error: true })
  }
}

// ---------------------------------------------------------------- toast
let toastTimer = null
function toast(text, { action, onAction, error = false, sticky = false, duration = 3500 } = {}) {
  const el = $('toast')
  $('toast-text').textContent = text
  el.classList.toggle('error', error)
  const btn = $('toast-action')
  btn.hidden = !action
  btn.textContent = action ?? ''
  btn.onclick = action
    ? () => {
        el.hidden = true
        onAction?.()
      }
    : null
  el.hidden = false
  clearTimeout(toastTimer)
  if (!sticky) toastTimer = setTimeout(() => (el.hidden = true), error ? 5000 : duration)
}
function shorten(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

// ---------------------------------------------------------------- events
$('search-input').addEventListener('input', onSearchInput)
$('search-input').addEventListener('focus', () => {
  if (ui.search.q.trim()) {
    ui.search.open = true
    onSearchInput()
  }
})
$('search-input').addEventListener('paste', () => {
  // A pasted link is almost always meant to be tracked: show the option immediately.
  setTimeout(onSearchInput, 0)
})
$('search-input').addEventListener('keydown', (e) => {
  const n = options().length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    ui.search.sel = Math.min(n - 1, ui.search.sel + 1)
    renderSuggestions()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    ui.search.sel = Math.max(0, ui.search.sel - 1)
    renderSuggestions()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (n) void choose(ui.search.sel, { openDetail: e.shiftKey || e.ctrlKey || e.metaKey })
  } else if (e.key === 'Escape') {
    e.preventDefault()
    if (ui.search.q) clearSearch()
    else $('search-input').blur()
  }
})
$('search-clear').addEventListener('click', () => {
  clearSearch()
  $('search-input').focus()
})
$('suggestions').addEventListener('mousedown', (e) => e.preventDefault())
$('suggestions').addEventListener('click', (e) => {
  const el = e.target.closest('[data-opt]')
  if (el) void choose(Number(el.dataset.opt), { openDetail: e.shiftKey || e.ctrlKey || e.metaKey })
})
$('search-input').addEventListener('blur', () => setTimeout(() => {
  if (document.activeElement !== $('search-input')) {
    ui.search.open = false
    $('suggestions').hidden = true
  }
}, 120))

$('refresh-btn').addEventListener('click', () => refresh())
$('menu-btn').addEventListener('click', (e) => {
  e.stopPropagation()
  const menu = $('menu')
  menu.hidden = !menu.hidden
  if (!menu.hidden) menu.querySelector('button')?.focus()
})
$('menu').addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action
  if (!action) return
  $('menu').hidden = true
  if (action === 'bulk') openSheet('bulk')
  if (action === 'import') openSheet('import')
  if (action === 'seen') request('items.seen', {}).then(() => toast('All caught up')).catch(() => undefined)
  if (action === 'density') {
    prefs.compact = !prefs.compact
    savePrefs()
    render()
  }
  if (action === 'export-json') void exportJson()
  if (action === 'export-csv') void exportCsv()
})
document.addEventListener('click', (e) => {
  if (!$('menu').hidden && !e.target.closest('#menu')) $('menu').hidden = true
})

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    prefs.filter = prefs.filter === chip.dataset.filter && chip.dataset.filter !== 'all' ? 'all' : chip.dataset.filter
    ui.kbd = -1
    savePrefs()
    render()
  })
}
$('sort').addEventListener('change', (e) => {
  prefs.sort = e.target.value
  savePrefs()
  render()
})
$('items').addEventListener('click', (e) => {
  if (e.target.closest('[data-filter-reset]')) {
    prefs.filter = 'all'
    savePrefs()
    return render()
  }
  const el = e.target.closest('.card')
  if (el) openItem(el.dataset.key)
})
$('items').addEventListener('contextmenu', (e) => {
  // Right-click a card: quick pin toggle without opening it.
  const el = e.target.closest('.card')
  const item = el && ui.state.items.find((i) => keyOf(i) === el.dataset.key)
  if (!item) return
  e.preventDefault()
  void update(item, { pinned: !item.pinned }, item.pinned ? 'Unpinned' : 'Pinned to top')
})

$('back-btn').addEventListener('click', closeDetail)
$('pin-btn').addEventListener('click', () => {
  const item = currentItem()
  if (item) void update(item, { pinned: !item.pinned }, item.pinned ? 'Unpinned' : 'Pinned to top')
})
$('open-btn').addEventListener('click', () => {
  const item = currentItem()
  if (item) void openExternal(productUrl(item.host, item.id))
})
$('copy-btn').addEventListener('click', () => {
  const item = currentItem()
  if (item) void copy(productUrl(item.host, item.id))
})
$('remove-btn').addEventListener('click', () => {
  const item = currentItem()
  if (item) void removeItem(item)
})

$('detail').addEventListener('click', (e) => {
  const item = currentItem()
  if (!item) return
  const range = e.target.closest('[data-range]')?.dataset.range
  if (range) {
    prefs.range = range
    savePrefs()
    for (const b of document.querySelectorAll('[data-range]')) b.setAttribute('aria-pressed', String(b.dataset.range === range))
    return renderDetailSection('chart')
  }
  const quick = e.target.closest('[data-quick]')?.dataset.quick
  if (quick) {
    const sum = summarize(item)
    const value = quick === 'low' ? sum.low?.price : Math.floor(sum.price * (1 - Number(quick) / 100))
    if (value) return update(item, { target: value }, `Target set to ${formatPrice(value, item.host)}`)
  }
  if (e.target.closest('#target-clear')) return update(item, { target: null }, 'Target cleared')
  if (e.target.closest('#refresh-one')) return refresh(item)
  if (e.target.closest('#offers-retry')) return loadOffers(item, true)
  if (e.target.closest('#more-offers')) {
    ui.showAllOffers = !ui.showAllOffers
    return renderDetailSection('offers')
  }
  const offer = e.target.closest('[data-offer]')
  if (offer) {
    const data = ui.offers.get(keyOf(item))
    const o = data?.offers?.[Number(offer.dataset.offer)]
    if (o) void openExternal(o.url)
  }
})
$('detail').addEventListener('submit', (e) => {
  if (e.target.id !== 'target-form') return
  e.preventDefault()
  const item = currentItem()
  const raw = $('target-input').value.replace(/\s/g, '').replace(',', '.').replace(/[^\d.]/g, '')
  const value = raw ? Number(raw) : null
  if (raw && !(value > 0)) return toast('Type a price, like 4999', { error: true })
  $('target-input').blur()
  void update(item, { target: value }, value ? `Target set to ${formatPrice(value, item.host)}` : 'Target cleared')
})
let noteTimer = null
$('detail').addEventListener('input', (e) => {
  if (e.target.id !== 'note') return
  const item = currentItem()
  const value = e.target.value
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => request('item.update', { id: item.id, host: item.host, patch: { note: value } }).catch(() => undefined), 500)
})
$('detail').addEventListener('focusout', () => {
  setTimeout(() => {
    if (detailQueued) renderDetailSoon()
  }, 50)
})

$('sheet-cancel').addEventListener('click', closeSheet)
$('sheet-backdrop').addEventListener('click', closeSheet)
$('sheet-ok').addEventListener('click', submitSheet)
$('sheet-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitSheet()
  if (e.key === 'Escape') closeSheet()
})

document.addEventListener('keydown', (e) => {
  const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '')
  if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !inField)) {
    e.preventDefault()
    if (ui.detailKey) closeDetail()
    $('search-input').focus()
    $('search-input').select()
    return
  }
  if (inField || !$('sheet').hidden) return
  if (e.key === 'Escape') {
    if (!$('menu').hidden) $('menu').hidden = true
    else if (ui.detailKey) closeDetail()
    return
  }
  if (ui.detailKey) {
    const item = currentItem()
    if (!item) return
    if (e.key === 'Backspace' || e.key === 'ArrowLeft') closeDetail()
    else if (e.key === 'p') $('pin-btn').click()
    else if (e.key === 'o') $('open-btn').click()
    else if (e.key === 'Delete') $('remove-btn').click()
    else if (e.key === 't') $('target-input')?.focus()
    else if (/^[1-6]$/.test(e.key)) $('detail').querySelector(`[data-range="${RANGES[Number(e.key) - 1][0]}"]`)?.click()
    return
  }
  const cards = [...document.querySelectorAll('.card')]
  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault()
    ui.kbd = Math.min(cards.length - 1, ui.kbd + 1)
    cards[ui.kbd]?.focus()
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault()
    ui.kbd = Math.max(0, ui.kbd - 1)
    cards[ui.kbd]?.focus()
  } else if (e.key === 'r') refresh()
  else if (e.key === 'c') {
    prefs.compact = !prefs.compact
    savePrefs()
    render()
  }
})

new ResizeObserver(() => {
  if (ui.detailKey) renderDetailSection('chart')
}).observe(document.body)

// keep "Updated 5 min ago" honest without re-rendering everything
setInterval(() => {
  if (ui.state && !ui.detailKey) renderFoot()
}, 30_000)

renderItems()
void loadState()

// expose for debugging in DevTools (orca plugin dev inspect)
window.__prisjakt = { ui, prefs, fold }
