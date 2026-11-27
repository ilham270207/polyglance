// PolyGlance v8.4 — label ODDS (pure, no SDK, no network).
// "Will Bitcoin dip to $55,000 in November?" -> "BTC dip $55,000? YES 48%"
// Dipindah dari main.ts (v8.4) supaya logika label bisa di-unit-test.
// v8.4 menambahkan dedupe: dua pasar dengan aset + angka yang sama (beda
// tanggal) tidak lagi tampil dengan label identik di halaman yang sama.

const ASSET_SYM: Array<[RegExp, string]> = [
  [/\bbitcoin\b/i, 'BTC'],
  [/\bbtc\b/i, 'BTC'],
  [/\bethereum\b/i, 'ETH'],
  [/\beth\b/i, 'ETH'],
  [/\bsolana\b/i, 'SOL'],
  [/\bsol\b/i, 'SOL'],
  [/\bdogecoin\b/i, 'DOGE'],
  [/\bdoge\b/i, 'DOGE'],
  [/\bxrp\b/i, 'XRP'],
  [/\bcryptocurrency\b/i, 'CRYPTO'],
  [/\bcrypt\b/i, 'CRYPTO'],
]

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s
}

export function shortOddsLabel(question: string, yesPct: number): string {
  const q = question.trim()
  let sym = ''
  for (const [re, s] of ASSET_SYM) {
    if (re.test(q)) { sym = s; break }
  }
  const amt = q.match(/\$[\d,]+(?:\.\d+)?/)
  const verb = /\b(dip|fall|drop|below|under)\b/i.test(q)
    ? 'dip'
    : /\b(reach|rise|exceed|above|over|hit)\b/i.test(q)
      ? 'reach'
      : 'hit'
  if (sym && amt) {
    const label = `${sym} ${verb} ${amt[0]}? YES ${yesPct}%`
    if (label.length <= 34) return label
  }
  // Fallback: ekor pertanyaan (bagian yang membedakan, mis. angka target)
  // dipotong dari depan agar bagian akhir yang tampil.
  const tail = q.replace(/^Will\s+/i, '')
  const label = `${truncate(tail, 22)} YES ${yesPct}%`
  return label.length <= 34 ? label : `${truncate(tail, 20)} YES ${yesPct}%`
}

/** Label pasar TANPA angka YES% — dipakai view ODDS-ALERT (YES% punya baris
  sendiri). "Will Bitcoin dip to $55,000 in November?" -> "BTC dip $55,000?" */
export function shortOddsQuestion(question: string): string {
  const q = question.trim()
  let sym = ''
  for (const [re, s] of ASSET_SYM) {
    if (re.test(q)) { sym = s; break }
  }
  const amt = q.match(/\$[\d,]+(?:\.\d+)?/)
  const verb = /\b(dip|fall|drop|below|under)\b/i.test(q)
    ? 'dip'
    : /\b(reach|rise|exceed|above|over|hit)\b/i.test(q)
      ? 'reach'
      : 'hit'
  if (sym && amt) {
    const label = `${sym} ${verb} ${amt[0]}?`
    if (label.length <= 34) return label
  }
  const tail = q.replace(/^Will\s+/i, '')
  return truncate(tail, 34)
}

const MONTHS: Array<[RegExp, string]> = [
  [/\bjanuary\b/i, 'JAN'],
  [/\bfebruary\b/i, 'FEB'],
  [/\bmarch\b/i, 'MAR'],
  [/\bapril\b/i, 'APR'],
  [/\bmay\b/i, 'MAY'],
  [/\bjune\b/i, 'JUN'],
  [/\bjuly\b/i, 'JUL'],
  [/\baugust\b/i, 'AUG'],
  [/\bseptember\b/i, 'SEP'],
  [/\boctober\b/i, 'OCT'],
  [/\bnovember\b/i, 'NOV'],
  [/\bdecember\b/i, 'DEC'],
]

/** Singkatan bulan dari pertanyaan ("...in November?" -> "NOV"), null kalau
  tidak ada bulan. Dipakai hanya untuk membedakan label yang tabrakan. */
export function monthAbbr(question: string): string | null {
  for (const [re, abbr] of MONTHS) {
    if (re.test(question)) return abbr
  }
  return null
}

/** Label satu halaman ODDS (maks 3 pasar): label yang sama persis (dua
  pasar, aset + angka sama, beda tanggal) dibedakan dengan bulan dari
  pertanyaan ("BTC dip $55,000? YES 48% NOV"); kalau tidak ada bulan,
  pakai nomor urut (" (2)"). Kalau suffix tidak muat dalam 34 karakter,
  label dibiarkan apa adanya — tampilan tetap valid, tabrakan tetap
  mungkin tapi tidak pernah merusak layout. */
export function dedupeOddsLabels(markets: Array<{ question: string; yesPct: number }>): string[] {
  const seen = new Map<string, number>()
  return markets.map((m) => {
    const base = shortOddsLabel(m.question, m.yesPct)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    if (n === 0) return base
    const mon = monthAbbr(m.question)
    const suffix = mon ? ` ${mon}` : ` (${n + 1})`
    return base.length + suffix.length <= 34 ? base + suffix : base
  })
}
