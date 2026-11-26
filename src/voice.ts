// PolyGlance v5 — voice command parser (pure, no SDK, no network).
// Satu parser dipakai dua jalur: (1) hasil STT Groq Whisper, (2) command chips
// di halaman web pendamping. Deterministik, unit-testable di Node tanpa mic.
// Perintah dalam bahasa Inggris, pendek (Whisper paling akurat di sini).

export type Coin = 'BTC' | 'ETH'
export type AlertCoin = 'BTC' | 'ETH' | 'SOL'
export type VoiceView = 'ticker' | 'odds' | 'paper-btc' | 'paper-eth' | 'alerts' | 'voice'

export type VoiceAction =
  | { type: 'goto'; view: VoiceView }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'buy'; coin: Coin }
  | { type: 'sell'; coin: Coin }
  | { type: 'sell-all'; coin: Coin | 'ALL' }
  | { type: 'set-alert'; target: number; coin?: AlertCoin }
  | { type: 'cancel-alert' }
  | { type: 'refresh' }
  | { type: 'stop' }

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
}
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
}

/** "fifty eight thousand" -> 58000; "one hundred" -> 100; "58000" / "58,000" -> 58000. */
export function wordsToNumber(tokens: string[]): number | null {
  let total = 0
  let current = 0
  let seen = false
  for (const raw of tokens) {
    const t = raw.replace(/,/g, '')
    if (/^\d+$/.test(t)) {
      // Digit mentah: gabungkan ke current (mis. "58" "000" jarang, tapi aman).
      current = current * 1000 + parseInt(t, 10)
      seen = true
      continue
    }
    if (t in ONES) { current += ONES[t]; seen = true; continue }
    if (t in TENS) { current += TENS[t]; seen = true; continue }
    if (t === 'hundred') { current = (current === 0 ? 1 : current) * 100; seen = true; continue }
    if (t === 'thousand') { total += (current === 0 ? 1 : current) * 1000; current = 0; seen = true; continue }
    if (t === 'million') { total += (current === 0 ? 1 : current) * 1000000; current = 0; seen = true; continue }
    return null
  }
  if (!seen) return null
  return total + current
}

/** Ambil angka (kata atau digit) dari token — dipakai untuk target alert. */
function extractNumber(tokens: string[]): number | null {
  // Coba jendela token yang semuanya angka/kata-angka, dari yang terpanjang.
  for (let len = tokens.length; len >= 1; len--) {
    for (let start = 0; start + len <= tokens.length; start++) {
      const n = wordsToNumber(tokens.slice(start, start + len))
      if (n !== null && n > 0) return n
    }
  }
  return null
}

function detectCoin(tokens: string[]): Coin | null {
  if (tokens.includes('bitcoin') || tokens.includes('btc')) return 'BTC'
  if (tokens.includes('ethereum') || tokens.includes('eth')) return 'ETH'
  return null
}

function detectAlertCoin(tokens: string[]): AlertCoin | null {
  if (tokens.includes('bitcoin') || tokens.includes('btc')) return 'BTC'
  if (tokens.includes('ethereum') || tokens.includes('eth')) return 'ETH'
  if (tokens.includes('solana') || tokens.includes('sol')) return 'SOL'
  return null
}

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/[^\w\s$]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Parse satu perintah suara/teks menjadi aksi. Tidak cocok -> null (jangan nebak). */
export function parseVoiceCommand(text: string): VoiceAction | null {
  const tokens = normalize(text)
  if (tokens.length === 0) return null
  const has = (...words: string[]): boolean => words.some((w) => tokens.includes(w))

  // Hapus alert AKTIF — dicek DULU sebelum 'stop' generik, karena
  // "cancel alert" mengandung kata 'cancel'.
  // "cancel alert" / "remove alert" / "delete alert" / "clear alert"
  if (has('alert', 'alerts') && has('cancel', 'remove', 'delete', 'clear')) {
    return { type: 'cancel-alert' }
  }

  if (has('stop', 'cancel', 'nevermind', 'never', 'mind')) return { type: 'stop' }
  if (has('next')) return { type: 'next' }
  if (has('back', 'previous')) return { type: 'back' }
  if (has('refresh', 'update', 'reload')) return { type: 'refresh' }

  // Set alert: "set alert to fifty eight thousand" / "alert 58000" /
  // "set alert eth 1800" / "alert sol 150". Tanpa nama koin = aset aktif
  // di view ALERTS. Lantai parser 10 (bukan 1000): validasi per-aset
  // (BTC >=1000, ETH >=100, SOL >=10) dilakukan di main.ts, karena angka
  // yang kecil untuk BTC bisa jadi valid untuk SOL.
  if (has('alert', 'alerts')) {
    const target = extractNumber(tokens)
    if (target === null) {
      // "alerts" tanpa angka = pindah ke view ALERTS
      if (tokens.includes('alerts')) return { type: 'goto', view: 'alerts' }
      return null
    }
    if (target < 10) return null
    const coin = detectAlertCoin(tokens)
    return coin ? { type: 'set-alert', target, coin } : { type: 'set-alert', target }
  }

  // Buy / sell $100 (jumlah selalu 100 — "one hundred" boleh disebut atau tidak)
  if (has('buy', 'purchase', 'purchasing')) {
    const coin = detectCoin(tokens)
    if (coin) return { type: 'buy', coin }
    return null
  }
  if (has('sell')) {
    // Jual semua: "sell all bitcoin" = semua BTC, "sell all" = semua BTC+ETH.
    // SOL tidak punya paper holding — "sell all solana" ditolak, jangan nebak.
    if (has('all')) {
      if (has('solana', 'sol')) return null
      const coin = detectCoin(tokens)
      return { type: 'sell-all', coin: coin ?? 'ALL' }
    }
    const coin = detectCoin(tokens)
    if (coin) return { type: 'sell', coin }
    return null
  }

  // Pindah view
  if (has('ticker', 'price', 'prices')) return { type: 'goto', view: 'ticker' }
  if (has('odds', 'polymarket', 'bets', 'betting')) return { type: 'goto', view: 'odds' }
  if (has('paper', 'portfolio', 'trading', 'trade')) return { type: 'goto', view: 'paper-btc' }
  if (has('voice')) return { type: 'goto', view: 'voice' }

  return null
}

/** Bungkus PCM 16 kHz s16le mono mentah menjadi file WAV (header RIFF 44 byte). */
export function pcmToWav(pcm: Uint8Array, sampleRate = 16000): Uint8Array {
  const dataLen = pcm.length
  const out = new Uint8Array(44 + dataLen)
  const view = new DataView(out.buffer)
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // subchunk1 size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataLen, true)
  out.set(pcm, 44)
  return out
}

/** Level suara 0..1 dari chunk PCM (RMS) — untuk meter "LISTENING" di view VOICE. */
export function rmsLevel(pcm: Uint8Array): number {
  if (pcm.length < 2) return 0
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768
    sum += v * v
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 4)
}
