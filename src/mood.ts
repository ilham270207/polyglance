// PolyGlance v8.2 — MOOD view helpers (pure, no SDK, no network).
// MOOD = Fear & Greed (Alternative.me via Worker proxy /fng) + arah harga
// 24 jam (CoinGecko/Coinbase, sudah ada di view TICKER) + funding rate
// rata-rata Hyperliquid (sudah ada di view HL). File ini hanya menggabung
// ketiganya jadi satu skor + baris layar: ASCII, maks 34 karakter/baris.

export interface MoodInput {
  /** Fear & Greed index 0..100 (null kalau proxy gagal). */
  fng: number | null
  fngLabel: string
  /** Perubahan harga 24 jam BTC dalam persen (null kalau belum ada data). */
  btcChg: number | null
  /** Perubahan harga 24 jam koin dengan |chg| terbesar + simbolnya. */
  topMover: { symbol: string; chg: number } | null
  /** Rata-rata funding rate per jam dari 3 perp HL (null kalau belum ada). */
  fundingAvg: number | null
  /** true kalau fetch /fng terakhir gagal (tampilkan "offline"). */
  offline?: boolean
}

export type MoodLevel = 'risk-off' | 'cautious' | 'neutral' | 'risk-on' | 'euphoric'

/** Gabung F&G + arah harga + funding jadi satu level mood.
  Skor: F&G 0..100 -> -2..+2; arah BTC -> -1..+1; funding -> -1..+1.
  Total -4..+4: <=-2 risk-off, -1 cautious, 0 neutral, +1..+2 risk-on,
  >=+3 euphoric. Data yang kosong tidak ikut skor (netral). */
export function computeMoodLevel(m: MoodInput): MoodLevel {
  let score = 0
  if (m.fng !== null) {
    if (m.fng <= 24) score -= 2
    else if (m.fng <= 44) score -= 1
    else if (m.fng >= 76) score += 2
    else if (m.fng >= 55) score += 1
  }
  if (m.btcChg !== null) {
    if (m.btcChg <= -3) score -= 1
    else if (m.btcChg >= 3) score += 1
  }
  if (m.fundingAvg !== null) {
    if (m.fundingAvg <= -0.0005) score -= 1
    else if (m.fundingAvg >= 0.001) score += 1
  }
  if (score <= -2) return 'risk-off'
  if (score === -1) return 'cautious'
  if (score === 0) return 'neutral'
  if (score <= 2) return 'risk-on'
  return 'euphoric'
}

/** "funding +0.0013%/h" -> hangat/panas/dingin, satu kata. */
export function fundingWord(fundingAvg: number | null): string {
  if (fundingAvg === null) return 'no funding data'
  if (fundingAvg >= 0.005) return 'very hot'
  if (fundingAvg >= 0.001) return 'warm'
  if (fundingAvg >= 0) return 'mild'
  if (fundingAvg >= -0.001) return 'cooling'
  return 'cold'
}

/** Baris lengkap view MOOD (<=7 baris): header + F&G + harga + funding +
  level + footer. Semua <=34 karakter, ASCII. */
export function moodLines(m: MoodInput): string[] {
  const level = computeMoodLevel(m)
  const lines: string[] = ['MOOD - MARKET IN ONE LOOK']
  if (m.fng !== null) {
    lines.push(`FEAR ${m.fng} - ${m.fngLabel.toUpperCase()}`)
  } else {
    lines.push(m.offline ? 'FEAR - offline' : 'FEAR - no data')
  }
  if (m.btcChg !== null) {
    const sign = m.btcChg >= 0 ? '+' : ''
    let line = `BTC ${sign}${m.btcChg.toFixed(1)}% 24h`
    if (m.topMover && m.topMover.symbol !== 'BTC') {
      const s2 = m.topMover.chg >= 0 ? '+' : ''
      line += `  ${m.topMover.symbol} ${s2}${m.topMover.chg.toFixed(1)}%`
    }
    lines.push(line.slice(0, 34))
  } else {
    lines.push('prices loading...')
  }
  if (m.fundingAvg !== null) {
    lines.push(`funding ${(m.fundingAvg * 100).toFixed(4)}%/h ${fundingWord(m.fundingAvg)}`)
  } else {
    lines.push('funding loading...')
  }
  lines.push(`mood: ${level}`)
  lines.push('tap: sltp >')
  return lines.slice(0, 8)
}
