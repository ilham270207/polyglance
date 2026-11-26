// PolyGlance v8.2 — ASK client di sisi kacamata (fetch ke Worker /ask).
// Kacamata TIDAK memanggil Groq langsung: Groq key ada di Worker (secret),
// dan konteks live (harga/odds/F&G/funding) dibangun server-side supaya
// jawaban WAJIB mengutip angka live. Kacamata hanya kirim pertanyaan.
// Timeout 20 detik — Groq chat biasanya <5 detik; kalau timeout, view ASK
// menampilkan "ASK FAILED - try again" (bukan jawaban karangan).

import { getSttProxyUrl } from './stt.js'

export const ASK_TIMEOUT_MS = 20000

/** Ambil URL dasar Worker dari URL proxy STT yang sama (localStorage
  'polyglance.stt-proxy.v1', via getSttProxyUrl — normalisasi: buang
  trailing '/stt'), atau fallback ke Worker publik. Proxy STT dan endpoint
  /ask + /whales + /fng tinggal di Worker yang SAMA, jadi satu URL dasar
  cukup untuk semuanya. */
export function getAskBaseUrl(): string {
  try {
    const proxy = getSttProxyUrl()
    if (proxy) {
      const u = new URL(proxy.replace(/\/stt$/i, ''))
      return `${u.protocol}//${u.host}`
    }
  } catch {
    // abaikan — pakai fallback
  }
  return 'https://polyglance-watcher.danham322.workers.dev'
}

/** Tanya pasar. Kembalikan jawaban (maks 2 baris) atau null kalau gagal.
  Jawaban DIBUNGKUS client-side ke <=34 karakter/baris (wrapAskAnswer). */
export async function askMarket(question: string): Promise<string | null> {
  const q = question.trim()
  if (q.length < 3) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS)
  try {
    const res = await fetch(`${getAskBaseUrl()}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q.slice(0, 200) }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as { answer?: string }
    if (typeof data.answer !== 'string' || data.answer.trim().length === 0) return null
    return data.answer.trim()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Bungkus jawaban jadi baris layar <=34 karakter, maks 4 baris.
  Jawaban Worker sudah <=2 baris, tapi bungkus ulang di sini supaya aturan
  display tidak pernah dilanggar walau Worker mengirim baris panjang. */
export function wrapAskAnswer(answer: string, maxLines = 4, maxLen = 34): string[] {
  const words = answer.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (next.length <= maxLen) {
      cur = next
    } else {
      if (cur) lines.push(cur)
      cur = w.length > maxLen ? w.slice(0, maxLen) : w
    }
  }
  if (cur) lines.push(cur)
  return lines.slice(0, maxLines)
}
