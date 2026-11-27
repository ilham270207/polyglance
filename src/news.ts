// PolyGlance v8.4 — NEWS view helpers (pure, no SDK, no network).
// Data datang dari Worker GET /news (proxy RSS CoinDesk, fallback
// Cointelegraph). File ini hanya memformat baris layar: ASCII, maks 34
// karakter/baris, maks 8 baris/view. TIDAK PERNAH mengarang headline:
// kalau feed gagal, tampilkan "no news right now" — bukan judul buatan.

/** Satu baris judul sudah dipotong ke <=34 karakter (dengan '...' kalau
  dipotong). Judul mentah dari RSS bisa panjang; potong dari akhir supaya
  awal judul — bagian yang paling informatif — tetap utuh. */
export function shortNewsTitle(title: string, maxLen = 34): string {
  const s = title.replace(/\s+/g, ' ').trim()
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen - 3).trimEnd() + '...'
}

/** Baris lengkap view NEWS (<=8 baris): header + sampai 4 headline +
  footer. `loaded` = fetch /news sudah selesai (walau 0 headline): kalau
  loaded tapi kosong, tampilkan "no news right now" — BUKAN "loading
  news..." (yang hanya benar sebelum fetch pertama selesai). */
export function newsLines(
  headlines: string[] | null,
  offline: boolean,
  updated: string,
  loaded = false,
): string[] {
  const lines: string[] = ['NEWS - CRYPTO HEADLINES']
  if (!headlines || headlines.length === 0) {
    lines.push(offline ? 'OFFLINE - no data yet' : loaded ? 'no news right now' : 'loading news...')
    lines.push('tap: ticker >')
    return lines
  }
  for (const h of headlines.slice(0, 4)) {
    lines.push(shortNewsTitle(h))
  }
  // Baris status (updated/offline) hanya kalau muat BERSAMA footer
  // 'tap: ticker >' dalam batas 8 baris — footer navigasi tidak boleh
  // terpotong slice(0, 8) saat 4 headline tampil.
  if (lines.length + 2 <= 8) {
    if (offline) lines.push('OFFLINE - last data shown')
    else if (updated) lines.push(`updated ${updated}`)
  }
  lines.push('tap: ticker >')
  return lines.slice(0, 8)
}
