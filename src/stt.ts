// PolyGlance v5 — Groq Whisper STT client (browser/WebView).
// Key TIDAK PERNAH di-hardcode: diambil dari localStorage (diisi user lewat
// halaman settings di HP). Tanpa key -> return null, view VOICE mati elegan.
//
// Fallback proxy: fetch langsung ke api.groq.com dari WebView kacamata bisa
// HANG (Cloudflare menahan client WebKitGTK — terbukti di simulator 26 Nov
// ~02:00 WIB; CoinGecko + Gamma dari WebView yang sama lancar, curl dari
// mesin yang sama dapat 401 dalam 0,27 detik; fase 1 fetch yang sama sempat
// lolos, jadi kondisinya berubah-ubah). Kalau direct gagal/timeout dan URL
// proxy terisi di settings, otomatis coba lewat proxy (Cloudflare Worker yang
// teruskan audio ke Groq pakai key dari Worker secret). Direct sukses —
// termasuk transcript kosong ("tidak mendengar apa-apa") — proxy TIDAK PERNAH
// dipanggil.

import { pcmToWav } from './voice.js'

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const GROQ_MODEL = 'whisper-large-v3-turbo'

export const GROQ_KEY_STORAGE = 'polyglance.groq-key.v1'
export const STT_PROXY_STORAGE = 'polyglance.stt-proxy.v1'

export function getGroqKey(): string | null {
  try {
    return localStorage.getItem(GROQ_KEY_STORAGE) || null
  } catch {
    return null
  }
}

/**
 * URL proxy STT (Cloudflare Worker, .../stt) atau null kalau tidak diset.
 * Normalisasi: buang spasi + trailing slash; kalau belum berakhiran /stt,
 * tambahkan (jadi boleh tempel URL root Worker saja).
 */
export function getSttProxyUrl(): string | null {
  try {
    const raw =
      (typeof localStorage !== 'undefined' ? localStorage.getItem(STT_PROXY_STORAGE) : null) || ''
    let url = raw.trim().replace(/\/+$/, '')
    if (!url) return null
    if (!/^https?:\/\//i.test(url)) return null
    if (!/\/stt$/i.test(url)) url += '/stt'
    return url
  } catch {
    return null
  }
}

export function setSttProxyUrl(url: string): void {
  try {
    const v = (url || '').trim()
    if (!v) localStorage.removeItem(STT_PROXY_STORAGE)
    else localStorage.setItem(STT_PROXY_STORAGE, v)
  } catch {
    // abaikan
  }
}

// Timeout 25 detik: fetch ke Groq JANGAN PERNAH gantung selamanya.
// (Terbukti di simulator 26 Nov ~02:00 WIB: fetch ke api.groq.com dari WebView
// bisa hang tanpa respons — kemungkinan Cloudflare menahan client WebKitGTK —
// sementara curl dari mesin yang sama dapat 401 dalam 0,27 detik.)
const STT_TIMEOUT_MS = 25000
// Proxy menambah satu hop (WebView -> Worker -> Groq): beri 30 detik.
const STT_PROXY_TIMEOUT_MS = 30000

function buildWavForm(pcm: Uint8Array): FormData {
  const wav = pcmToWav(pcm)
  const form = new FormData()
  form.append('file', new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }), 'voice.wav')
  form.append('model', GROQ_MODEL)
  form.append('language', 'en')
  form.append('response_format', 'json')
  return form
}

async function readTranscript(res: Response): Promise<string | null> {
  if (!res.ok) return null
  try {
    const data = (await res.json()) as { text?: unknown }
    return typeof data.text === 'string' ? data.text.trim() : ''
  } catch {
    return null
  }
}

/** Jalur langsung ke Groq. null = gagal (network / 401 / timeout). */
export async function transcribeDirect(pcm: Uint8Array, apiKey: string): Promise<string | null> {
  if (pcm.length === 0) return ''
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), STT_TIMEOUT_MS)
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: buildWavForm(pcm),
      signal: ctrl.signal,
    })
    return await readTranscript(res)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Jalur proxy (Cloudflare Worker POST /stt). Key Groq dipegang Worker secret —
 * client tidak kirim key. Balasan Worker sama: JSON { text }.
 */
export async function transcribeViaProxy(pcm: Uint8Array, proxyUrl: string): Promise<string | null> {
  if (pcm.length === 0) return ''
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), STT_PROXY_TIMEOUT_MS)
  try {
    const res = await fetch(proxyUrl, {
      method: 'POST',
      body: buildWavForm(pcm),
      signal: ctrl.signal,
    })
    return await readTranscript(res)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Kirim PCM mentah (16 kHz s16le mono, diakumulasi dari audioEvent) ke Groq.
 * 1. Coba direct dulu (25 detik). Sukses — termasuk transcript kosong — selesai.
 * 2. Kalau direct gagal DAN proxy URL terisi di settings -> coba proxy (30 detik).
 * Return transcript (string kosong kalau Whisper tidak mendengar apa-apa),
 * atau null kalau semua jalur gagal.
 */
export async function transcribePcm(pcm: Uint8Array, apiKey: string): Promise<string | null> {
  const direct = await transcribeDirect(pcm, apiKey)
  if (direct !== null) return direct
  const proxyUrl = getSttProxyUrl()
  if (!proxyUrl) return null
  return transcribeViaProxy(pcm, proxyUrl)
}
