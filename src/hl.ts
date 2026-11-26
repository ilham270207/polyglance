// PolyGlance v8 — Hyperliquid perps parser (pure, no SDK, no network).
// Satu panggilan POST /info {type: 'metaAndAssetCtxs'} mengembalikan
// [meta, assetCtxs]: meta.universe[i].name = 'BTC'/'ETH'/..., assetCtxs[i]
// membawa markPx, prevDayPx, funding (per jam), openInterest (dalam koin).
// Read-only: harga perp + funding + open interest saja — tanpa wallet,
// tanpa order, tanpa signing.

export interface HlRow {
  sym: string
  mark: number
  /** Perubahan 24 jam (%) dari markPx vs prevDayPx. */
  chg: number
  /** Funding rate per jam (mis. 0.0000125 = 0.00125%/jam). */
  funding: number
  /** Open interest dalam USD (openInterest koin x markPx). */
  oiUsd: number
}

const HL_SYMS = ['BTC', 'ETH', 'SOL']

/** Parse balasan metaAndAssetCtxs -> baris BTC/ETH/SOL, atau null kalau
  bentuknya tidak dikenali / satu koin hilang / angkanya tidak valid.
  Satu koin rusak = seluruh payload ditolak (jangan tampil setengah). */
export function parseHlPerps(data: unknown): HlRow[] | null {
  if (!Array.isArray(data) || data.length < 2) return null
  const meta = data[0] as { universe?: unknown } | null
  const ctxs = data[1]
  if (!meta || typeof meta !== 'object' || !Array.isArray(meta.universe)) return null
  if (!Array.isArray(ctxs)) return null
  const universe = meta.universe as Array<{ name?: unknown }>
  const rows: HlRow[] = []
  for (const sym of HL_SYMS) {
    const i = universe.findIndex((u) => u && u.name === sym)
    if (i < 0 || i >= ctxs.length) return null
    const c = ctxs[i] as Record<string, unknown>
    const mark = Number(c.markPx)
    const prev = Number(c.prevDayPx)
    const funding = Number(c.funding)
    const oi = Number(c.openInterest)
    if (![mark, prev, funding, oi].every(Number.isFinite)) return null
    if (mark <= 0 || prev <= 0 || oi < 0) return null
    rows.push({ sym, mark, chg: ((mark - prev) / prev) * 100, funding, oiUsd: oi * mark })
  }
  return rows
}

/** Funding per jam -> "+0.0013%/h" (4 desimal — funding BTC sering 0.0001%/jam). */
export function fmtFunding(f: number): string {
  const pct = f * 100
  return `${pct >= 0 ? '+' : '-'}${Math.abs(pct).toFixed(4)}%/h`
}

/** Open interest USD -> "$2.2B" / "$291M" / "$45K" / "$500". */
export function fmtOi(usd: number): string {
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(1)}B`
  if (usd >= 1e6) return `$${Math.round(usd / 1e6)}M`
  if (usd >= 1e3) return `$${Math.round(usd / 1e3)}K`
  return `$${Math.round(usd)}`
}
