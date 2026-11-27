// PolyGlance v8.4 — PAPER SL/TP helpers (pure, no SDK, no network).
// SL/TP = stop-loss / take-profit per posisi paper, sebagai % offset dari
// harga entry (mis. SL -5%, TP +10%). Posisi ditutup OTOMATIS saat harga
// menyentuh SL atau TP — dicek tiap refresh harga (refreshAll di main.ts).
// File ini murni logika + render: semua <=34 karakter/baris, ASCII.

export interface SltpPosition {
  sym: 'BTC' | 'ETH'
  holding: number // jumlah koin
  entry: number | null // harga entry rata-rata tertimbang (null = belum ada posisi)
  sl: number | null // % offset negatif, mis. -5 (null = tidak di-set)
  tp: number | null // % offset positif, mis. +10 (null = tidak di-set)
}

export const SLTP_DEFAULT_SL = -5
export const SLTP_DEFAULT_TP = 10
export const SLTP_SL_MIN = -50
export const SLTP_SL_MAX = -1
export const SLTP_TP_MIN = 1
export const SLTP_TP_MAX = 100

function fmtUsd(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

/** % perubahan harga vs entry. null kalau entry tidak ada / tidak valid. */
export function slTpPct(price: number, entry: number | null): number | null {
  if (entry === null || entry <= 0 || !Number.isFinite(price) || price <= 0) return null
  return ((price - entry) / entry) * 100
}

/** Cek satu posisi: kembalikan 'sl' | 'tp' kalau harga menyentuh ambang,
  null kalau tidak. SL dicek dulu — kalau keduanya kena di tick yang sama
  (tidak mungkin dalam praktik: pct cuma satu nilai), SL yang menang. */
export function slTpHit(pos: SltpPosition, price: number): 'sl' | 'tp' | null {
  if (pos.holding <= 0 || pos.entry === null) return null
  const pct = slTpPct(price, pos.entry)
  if (pct === null) return null
  if (pos.sl !== null && pct <= pos.sl) return 'sl'
  if (pos.tp !== null && pct >= pos.tp) return 'tp'
  return null
}

/** Entry baru saat beli $100 di harga sekarang: rata-rata tertimbang.
  Posisi baru (holding 0 / entry null) -> entry = harga beli. */
export function slTpEntryAfterBuy(
  holding: number,
  entry: number | null,
  price: number,
  usdBought: number,
): number {
  const bought = usdBought / price
  if (holding <= 0 || entry === null || entry <= 0) return price
  return (holding * entry + usdBought) / (holding + bought)
}

/** Geser SL/TP +-1% per swipe: SL di -50..-1, TP di +1..+100.
  Nilai null (belum di-set) mulai dari default (-5 / +10). */
export function adjustSlTp(field: 'sl' | 'tp', value: number | null, steps: number): number {
  const base = value ?? (field === 'sl' ? SLTP_DEFAULT_SL : SLTP_DEFAULT_TP)
  if (field === 'sl') return Math.min(SLTP_SL_MAX, Math.max(SLTP_SL_MIN, base + steps))
  return Math.min(SLTP_TP_MAX, Math.max(SLTP_TP_MIN, base + steps))
}

export interface SltpViewInput {
  /** Posisi terbuka (holding > 0), urutan BTC lalu ETH. */
  positions: SltpPosition[]
  /** Index posisi terpilih di `positions`. */
  selected: number
  /** Field yang sedang diedit (swipe up/down mengubah field ini). */
  field: 'sl' | 'tp'
  /** Harga sekarang per koin (0 = belum ada data). */
  prices: Record<'BTC' | 'ETH', number>
  /** Hasil penutupan SL/TP terakhir ('' kalau belum ada). */
  lastClose: string
  /** Label view berikutnya untuk footer (biasanya 'news'). */
  nextViewLabel: string
}

/** Baris lengkap view PAPER-SLTP (<=8 baris): header + posisi terpilih
  (holding, entry, % sekarang, SL/TP, hint swipe) + footer navigasi.
  Tap = pindah ke posisi berikutnya (atau ke view berikut kalau sudah di
  posisi terakhir); double-tap = ganti field yang diedit (SL <-> TP). */
export function slTpLines(input: SltpViewInput): string[] {
  const lines: string[] = ['PAPER SL/TP - auto-close']
  const { positions, selected, field, prices, lastClose, nextViewLabel } = input
  if (positions.length === 0) {
    lines.push('no open positions')
    lines.push('buy $100 on PAPER-BTC')
    if (lastClose) lines.push(lastClose.slice(0, 34))
    lines.push(`tap: ${nextViewLabel} >`)
    return lines.slice(0, 8)
  }
  const pos = positions[Math.min(selected, positions.length - 1)]
  const price = prices[pos.sym] ?? 0
  const pct = slTpPct(price, pos.entry)
  lines.push(`${pos.sym} ${pos.holding.toFixed(4)} = ${fmtUsd(pos.holding * price)}`)
  if (pos.entry === null || price <= 0) {
    lines.push('entry: -  now: loading...')
  } else {
    const sign = pct !== null && pct >= 0 ? '+' : ''
    lines.push(`entry ${fmtUsd(pos.entry)}  now ${sign}${pct !== null ? pct.toFixed(1) : '-'}%`)
  }
  const slStr = pos.sl !== null ? `${pos.sl}%` : 'off'
  const tpStr = pos.tp !== null ? `+${pos.tp}%` : 'off'
  lines.push(field === 'sl' ? `>SL ${slStr}  TP ${tpStr}` : `SL ${slStr}  >TP ${tpStr}`)
  lines.push(`up: +1%  dn: -1%  (${field.toUpperCase()})`)
  lines.push('dbl-tap: edit TP/SL')
  if (lastClose) lines.push(lastClose.slice(0, 34))
  const more = selected < positions.length - 1
  lines.push(more ? 'tap: next coin >' : `tap: ${nextViewLabel} >`)
  return lines.slice(0, 8)
}
