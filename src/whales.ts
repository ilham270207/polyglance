// PolyGlance v8.2 — WHALES view helpers (pure, no SDK, no network).
// Data datang dari Worker proxy GET /whales (Polymarket data-api v2 /trades,
// filter >=$1.000 + crypto, dedupe di core.mjs). File ini hanya memformat
// baris layar: ASCII, maks 34 karakter/baris, maks 8 baris/view.

export interface WhaleTrade {
  question: string
  outcome: string
  usd: number
  pct: number
  trader: string
  mins: number
}

/** $12.400 -> "$12.4K", $1.240.000 -> "$1.2M". */
export function formatWhaleUsd(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`
  if (usd >= 10_000) {
    const v = (usd / 1000).toFixed(1)
    return `$${v.endsWith('.0') ? v.slice(0, -2) : v}K`
  }
  if (usd >= 1_000) return `$${(usd / 1000).toFixed(1)}K`
  return `$${Math.round(usd)}`
}

/** Potong pertanyaan jadi label pendek yang masih bisa dibaca. */
export function shortWhaleQuestion(q: string, maxLen = 16): string {
  const s = q.trim().replace(/\s+/g, ' ')
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen - 1).trimEnd() + '?'
}

/** "2m ago" / "1h ago" / "just now". */
export function whaleAge(mins: number): string {
  if (mins < 1) return 'just now'
  if (mins < 60) return `${Math.floor(mins)}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

/** Satu trade -> 2 baris layar (baris 1: jumlah + outcome + pasar + odds,
  baris 2: trader + umur). Keduanya <=34 karakter, ASCII. */
export function whaleTradeLines(t: WhaleTrade): [string, string] {
  const line1 = `${formatWhaleUsd(t.usd)} ${t.outcome} ${shortWhaleQuestion(t.question)} ${Math.round(t.pct)}%`
  const line2 = `${t.trader.slice(0, 20)} · ${whaleAge(t.mins)}`
  return [line1.slice(0, 34), line2.slice(0, 34)]
}

/** Baris lengkap view WHALES (<=8 baris): header + sampai 3 trade + footer. */
export function whaleLines(trades: WhaleTrade[] | null, offline: boolean, updated: string): string[] {
  const lines: string[] = ['WHALES - BIG POLYMARKET BETS']
  if (!trades || trades.length === 0) {
    lines.push(offline ? 'OFFLINE - no data yet' : 'loading whales...')
    lines.push('tap: mood >')
    return lines
  }
  for (const t of trades.slice(0, 3)) {
    const [a, b] = whaleTradeLines(t)
    lines.push(a)
    lines.push(b)
  }
  // Baris status (updated/offline) hanya kalau muat BERSAMA footer
  // 'tap: mood >' dalam batas 8 baris — footer navigasi tidak boleh
  // terpotong slice(0, 8) saat 3 trade tampil.
  if (lines.length + 2 <= 8) {
    if (offline) lines.push('OFFLINE - last data shown')
    else if (updated) lines.push(`updated ${updated}`)
  }
  lines.push('tap: mood >')
  return lines.slice(0, 8)
}
