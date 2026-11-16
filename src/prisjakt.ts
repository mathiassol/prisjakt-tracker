// The only code that talks to Prisjakt. It uses the same JSON endpoints prisjakt.no's own pages
// call (search suggestions, price history, offer list), so no HTML scraping except a product's name
// when someone pastes a bare link. `fetchImpl` is injectable so tests never touch the network.
import { historyFromApi, imageUrl, productUrl } from '../panel/core.js'
import type { Offer, PricePoint, SearchHit } from './protocol'

export type Fetch = typeof globalThis.fetch

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*'
}

export class PrisjaktError extends Error {
  code: string
  constructor(message: string, code = 'action_failed') {
    super(message)
    this.code = code
  }
}

export type TimeRange = 'THREE_MONTHS' | 'SIX_MONTHS' | 'ONE_YEAR' | 'TWO_YEARS' | 'ALL'

export function createClient(fetchImpl: Fetch = globalThis.fetch) {
  async function call(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        ...init,
        headers: { ...HEADERS, ...(init.headers as Record<string, string> | undefined) },
        signal: controller.signal,
        redirect: 'follow'
      })
      if (res.status === 404) throw new PrisjaktError('Product not found on Prisjakt', 'not_found')
      if (res.status === 429) throw new PrisjaktError('Prisjakt is rate limiting, try again soon', 'rate_limited')
      if (!res.ok) throw new PrisjaktError(`Prisjakt answered ${res.status}`)
      return res
    } catch (error) {
      if (error instanceof PrisjaktError) throw error
      if ((error as Error)?.name === 'AbortError') throw new PrisjaktError('Prisjakt took too long to answer', 'timeout')
      throw new PrisjaktError(`Could not reach Prisjakt (${(error as Error)?.message ?? error})`, 'unavailable')
    } finally {
      clearTimeout(timer)
    }
  }

  async function json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await call(url, init)
    try {
      return (await res.json()) as T
    } catch {
      throw new PrisjaktError('Prisjakt sent something unexpected')
    }
  }

  return {
    /** Product suggestions for a search box, as prisjakt.no's own header search shows them. */
    async search(host: string, query: string): Promise<SearchHit[]> {
      const q = query.trim()
      if (!q) return []
      type Raw = { suggestion: string; product?: { id: number; name: string; price?: number | null; categoryName?: string; imageUrl?: string } }
      const raw = await json<Raw[]>(`https://${host}/api/search-suggestions?q=${encodeURIComponent(q)}`)
      return (Array.isArray(raw) ? raw : [])
        .filter((r) => r.suggestion === 'product' && r.product?.id)
        .map((r) => ({
          id: r.product!.id,
          host,
          name: r.product!.name,
          price: typeof r.product!.price === 'number' ? r.product!.price : null,
          category: r.product!.categoryName ?? null,
          image: r.product!.imageUrl ?? imageUrl(r.product!.id)
        }))
    },

    /** The lowest-price history across shops, as the product page's chart draws it. */
    async history(host: string, id: number, timeRange: TimeRange = 'ALL'): Promise<PricePoint[]> {
      type Raw = { priceHistory?: { historyItems?: { date: string; price: number | null }[] } }
      const raw = await json<Raw>(`https://${host}/api/price-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: id, timeRange, shopIds: [], variantIds: [] })
      })
      return historyFromApi(raw?.priceHistory?.historyItems ?? [])
    },

    /** Every shop's current offer, cheapest first. */
    async offers(host: string, id: number): Promise<Offer[]> {
      type Raw = {
        shopId: number
        shop?: { name?: string }
        price?: { amount?: number; currency?: string }
        stockStatus?: string
        clickoutUrl?: string
        condition?: string
        shipping?: { cheapest?: { price?: { amount?: number } } }
        shopUserReviews?: { score?: number }
        shopLogoUrl?: string
      }
      const raw = await json<Raw[]>(`https://${host}/api/offer-list/${id}`)
      return (Array.isArray(raw) ? raw : [])
        .filter((o) => typeof o.price?.amount === 'number')
        .map((o) => ({
          shop: o.shop?.name ?? `Shop ${o.shopId}`,
          shopId: o.shopId,
          price: o.price!.amount!,
          stock: o.stockStatus ?? 'Unknown',
          url: o.clickoutUrl ?? productUrl(host, id),
          shipping: typeof o.shipping?.cheapest?.price?.amount === 'number' ? o.shipping.cheapest.price.amount : null,
          used: !!o.condition && o.condition !== 'New',
          rating: typeof o.shopUserReviews?.score === 'number' ? o.shopUserReviews.score : null
        }))
        .sort((a, b) => a.price - b.price)
    },

    /** Name and category of a product, read from its page (only used when nothing else has them). */
    async meta(host: string, id: number): Promise<{ name: string; category: string | null }> {
      const res = await call(productUrl(host, id))
      const html = await res.text()
      const name = productNameFromHtml(html)
      if (!name) throw new PrisjaktError('That page does not look like a Prisjakt product', 'not_found')
      return { name, category: categoryFromHtml(html) }
    },

    /** A product thumbnail as a data URL, so the sandboxed panel can show it without network. */
    async image(id: number, size = 280): Promise<string | null> {
      try {
        const res = await call(imageUrl(id, size), { headers: { Accept: 'image/*' } }, 15_000)
        const type = res.headers.get('content-type') ?? 'image/jpeg'
        if (!type.startsWith('image/')) return null
        const bytes = (globalThis as unknown as { Buffer: { from(b: ArrayBuffer): { length: number; toString(enc: string): string } } }).Buffer.from(await res.arrayBuffer())
        if (bytes.length > 400_000) return null
        return `data:${type};base64,${bytes.toString('base64')}`
      } catch {
        return null
      }
    }
  }
}

export type Client = ReturnType<typeof createClient>

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' }
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z#0-9]+);/gi, (m, e) => ENTITIES[e] ?? m)
}

export function productNameFromHtml(html: string): string | null {
  // The page's React payload carries the clean product name: \"productName\":\"…\"
  const rsc = html.match(/\\"productName\\":\\"((?:[^"\\]|\\\\.)*?)\\"/)
  if (rsc) {
    try {
      const once = JSON.parse(`"${rsc[1]}"`) as string
      const name = once.replace(/\\(.)/g, '$1').trim()
      if (name) return name
    } catch {
      /* fall through to the meta tags */
    }
  }
  const tw = html.match(/<meta name="twitter:title" content="([^"]+)"/) ?? html.match(/<meta property="og:title" content="([^"]+)"/)
  if (tw) {
    // "Name - Black Friday: fra 7 698 kr" → "Name"
    const title = decodeEntities(tw[1]).replace(/\s+-\s+[^-]*(?:\d|kr|€|£|\$)[^-]*$/u, '').trim()
    if (title) return title
  }
  const t = html.match(/<title>([^<]+)<\/title>/)
  return t ? decodeEntities(t[1]).split(/\s+-\s+/)[0].trim() || null : null
}

export function categoryFromHtml(html: string): string | null {
  // The breadcrumb JSON-LD lists the categories; the last one before the product is its own.
  const m = html.match(/"@type\\?":\\?"BreadcrumbList\\?".*?"itemListElement\\?":(\[.*?\])\}/s)
  if (!m) return null
  const names = [...m[1].matchAll(/\\?"name\\?":\\?"([^"\\]+)/g)].map((x) => decodeEntities(x[1]))
  return names.length ? names[names.length - 1] : null
}
