// The panel <-> worker contract. The worker (src/worker.ts) answers these requests; the HTML panel
// (panel/app.js) calls them with orca.plugin.request and listens for the posts.

/** [epoch ms at local midnight, lowest price in major units, or null when nobody sells it]. */
export type PricePoint = [number, number | null]

export type Offer = {
  shop: string
  shopId: number
  price: number
  /** Prisjakt's stock status: InStock, OutOfStock, Backorder, Incoming, Unknown … */
  stock: string
  url: string
  shipping: number | null
  used: boolean
  rating: number | null
}

export type SearchHit = {
  id: number
  host: string
  name: string
  price: number | null
  category: string | null
  image: string
}

export type TrackedItem = {
  id: number
  host: string
  name: string
  category: string | null
  addedAt: number
  /** Lowest price when it was added: "since you started tracking". */
  addedPrice: number | null
  /** Current lowest price among in-stock offers (falls back to Prisjakt's own lowest). */
  price: number | null
  shop: string | null
  inStock: number
  offerCount: number
  history: PricePoint[]
  target: number | null
  pinned: boolean
  note: string
  tags: string[]
  /** Price the person last saw in the panel; a lower current price is an unseen drop. */
  seenPrice: number | null
  checkedAt: number
  /** When `price` last changed, and what it was before. */
  changedAt: number | null
  prevPrice: number | null
  error: string | null
  /** Prices already notified about, so a refresh never notifies twice for the same price. */
  notified: { target?: number | null; low?: number | null; drop?: number | null }
}

export type ItemPatch = Partial<Pick<TrackedItem, 'target' | 'pinned' | 'note' | 'tags' | 'name'>>

export type TrackerState = {
  items: TrackedItem[]
  refreshing: boolean
  lastRefresh: number | null
  market: string
  threshold: number
}

export type Detail = {
  id: number
  offers: Offer[]
  history: PricePoint[]
  fetchedAt: number
}

declare module 'orca' {
  interface PluginRequests {
    'state.get': { output: TrackerState }
    search: { input: { query: string; host?: string }; output: SearchHit[] }
    /** `ref` is a product link, a bare id, or a search hit's id with its host. */
    'item.add': { input: { ref: string; host?: string; name?: string; category?: string | null }; output: { item: TrackedItem; existed: boolean } }
    'item.remove': { input: { id: number; host: string }; output: { removed: TrackedItem | null } }
    'item.restore': { input: { item: TrackedItem }; output: { ok: true } }
    'item.update': { input: { id: number; host: string; patch: ItemPatch }; output: { item: TrackedItem } }
    'item.detail': { input: { id: number; host: string }; output: Detail }
    'items.refresh': { input: { id?: number; host?: string }; output: TrackerState }
    'items.seen': { input: { keys?: string[] }; output: { ok: true } }
    'items.import': { input: { items: unknown }; output: { added: number } }
    /** A thumbnail as a data URL; `cache: false` for search results that are not tracked. */
    image: { input: { id: number; cache?: boolean }; output: { dataUrl: string | null } }
  }
  interface PluginPanelEvents {
    /** Something changed (another panel, a background refresh): fetch `state.get` again. */
    changed: { rev: number; refreshing: boolean; progress?: { done: number; total: number } | null }
  }
}
