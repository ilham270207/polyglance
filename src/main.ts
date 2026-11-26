// PolyGlance v6 - 6 view + paper trade BTC/ETH + price alert + VOICE + Telegram
// v6: ALERTS multi-aset (BTC/ETH/SOL, ganti aset = double-tap di view ALERTS),
// TICKER 5 koin (BTC/ETH/SOL/DOGE/XRP), perintah suara baru (sell all,
// show/check portfolio, cancel/remove alert).
// Tap = pindah view (TICKER -> ODDS -> PAPER-BTC -> PAPER-ETH -> ALERTS -> VOICE -> TICKER).
// Double-tap = keluar (kecuali di view ALERTS: ganti aset). Swipe up/down = aksi per view.
// View VOICE: push-to-talk. Swipe up = mulai dengar, swipe up lagi = stop & kirim
// ke Groq Whisper (key dari localStorage, diisi lewat halaman settings di HP).
// Semua teks ASCII saja. Satu container 576x288, isEventCapture: 1.

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { parseVoiceCommand, rmsLevel, type VoiceAction, type AlertCoin } from './voice'
import { transcribePcm, getGroqKey, GROQ_KEY_STORAGE } from './stt'

const bridge = await waitForEvenAppBridge()

// ---------- helpers format ----------
function fmtUsd(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

/** Harga per koin: BTC/ETH dolar bulat, SOL/XRP 2 desimal, DOGE 4 desimal. */
function fmtCoinPrice(sym: string, n: number): string {
  if (sym === 'DOGE') return '$' + n.toFixed(4)
  if (sym === 'SOL' || sym === 'XRP') return '$' + n.toFixed(2)
  return fmtUsd(n)
}

function fmtChg(n: number): string {
  return `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(1)}%`
}

function fmtTime(d: Date): string {
  return d.toTimeString().slice(0, 8)
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s
}

// ---------- state ----------
type View = 'ticker' | 'odds' | 'paper-btc' | 'paper-eth' | 'alerts' | 'voice'
let view: View = 'ticker'

interface Prices {
  btc: number; eth: number; sol: number; doge: number; xrp: number
  btcChg: number; ethChg: number; solChg: number; dogeChg: number; xrpChg: number
}
let prices: Prices | null = null

/** Harga aset alert (BTC/ETH/SOL) dari state prices — 0 kalau belum ada data. */
function priceOf(coin: AlertCoin): number {
  if (!prices) return 0
  return coin === 'BTC' ? prices.btc : coin === 'ETH' ? prices.eth : prices.sol
}
let lastUpdated = ''
let offline = false

interface Market { question: string; yesPct: number; vol24h: number }
let markets: Market[] = []
let oddsPage = 0

// ---------- paper trade (BTC + ETH, cash bersama) ----------
const PAPER_KEY_V2 = 'polyglance.paper.v2'
const PAPER_KEY_V1 = 'polyglance.paper.v1'
interface PaperState { cash: number; btc: number; eth: number }

function loadPaper(): PaperState {
  try {
    const raw2 = localStorage.getItem(PAPER_KEY_V2)
    if (raw2) {
      const p = JSON.parse(raw2) as Partial<PaperState>
      if (typeof p.cash === 'number' && typeof p.btc === 'number' && typeof p.eth === 'number') {
        return { cash: p.cash, btc: p.btc, eth: p.eth }
      }
    }
    // Migrasi mulus dari v1 {cash, btc} - ETH mulai 0.
    const raw1 = localStorage.getItem(PAPER_KEY_V1)
    if (raw1) {
      const p = JSON.parse(raw1) as Partial<PaperState>
      if (typeof p.cash === 'number' && typeof p.btc === 'number') {
        return { cash: p.cash, btc: p.btc, eth: 0 }
      }
    }
  } catch {
    // localStorage tidak tersedia / data rusak -> mulai dari awal
  }
  return { cash: 10000, btc: 0, eth: 0 }
}

let paper: PaperState = loadPaper()

function savePaper(): void {
  try {
    localStorage.setItem(PAPER_KEY_V2, JSON.stringify(paper))
  } catch {
    // abaikan - state tetap jalan di memori sesi ini
  }
}

// ---------- price alert (BTC/ETH/SOL, v6) ----------
// Alert "naik ke target": menyala saat harga aset mencapai/melewati target.
// Target default selalu DI ATAS harga saat ini (step berikutnya) supaya
// tidak langsung trigger saat pertama kali diset.
// Step geser target per aset: BTC $1.000, ETH $100, SOL $10.
// v2 menyimpan alert per aset + aset aktif; data v1 (BTC saja) dimigrasi
// mulus ke alerts.BTC supaya target lama pengguna tidak hilang.
const ALERT_KEY_V2 = 'polyglance.alert.v2'
const ALERT_KEY_V1 = 'polyglance.alert.v1'
interface SingleAlert { target: number; armed: boolean; triggered: boolean }
interface AlertStateV2 {
  active: AlertCoin
  alerts: Record<AlertCoin, SingleAlert>
  /** true setelah target default pertama kali dibuat. Kalau false, fetch
    harga pertama akan mengisi target default + meng-arm semua aset.
    Mencegah alert yang sengaja di-cancel diam-diam hidup lagi. */
  seeded: boolean
}

const ALERT_STEP: Record<AlertCoin, number> = { BTC: 1000, ETH: 100, SOL: 10 }
const ALERT_MIN: Record<AlertCoin, number> = { BTC: 1000, ETH: 100, SOL: 10 }

function blankAlert(): SingleAlert {
  return { target: 0, armed: false, triggered: false }
}

function loadAlert(): AlertStateV2 {
  try {
    const raw2 = localStorage.getItem(ALERT_KEY_V2)
    if (raw2) {
      const a = JSON.parse(raw2) as Partial<AlertStateV2>
      if (a.alerts && typeof a.alerts === 'object') {
        const read = (c: AlertCoin): SingleAlert => {
          const s = (a.alerts as Record<string, Partial<SingleAlert> | undefined>)[c]
          return (s && typeof s.target === 'number')
            ? { target: s.target, armed: s.armed === true, triggered: s.triggered === true }
            : blankAlert()
        }
        const active: AlertCoin = a.active === 'ETH' || a.active === 'SOL' ? a.active : 'BTC'
        // State v2 tanpa field seeded (dibuat v6 awal) dianggap sudah seeded —
        // kalau tidak, alert yang baru di-cancel akan dibuat ulang.
        return {
          active,
          alerts: { BTC: read('BTC'), ETH: read('ETH'), SOL: read('SOL') },
          seeded: a.seeded !== false,
        }
      }
    }
    // Migrasi mulus dari v1 {target, armed, triggered} (BTC saja).
    const raw1 = localStorage.getItem(ALERT_KEY_V1)
    if (raw1) {
      const a = JSON.parse(raw1) as Partial<SingleAlert>
      if (typeof a.target === 'number') {
        return {
          active: 'BTC',
          alerts: {
            BTC: { target: a.target, armed: a.armed === true, triggered: a.triggered === true },
            ETH: blankAlert(),
            SOL: blankAlert(),
          },
          seeded: true,
        }
      }
    }
  } catch {
    // abaikan - mulai tanpa target
  }
  return {
    active: 'BTC',
    alerts: { BTC: blankAlert(), ETH: blankAlert(), SOL: blankAlert() },
    seeded: false,
  }
}

let alertState: AlertStateV2 = loadAlert()

function saveAlert(): void {
  try {
    localStorage.setItem(ALERT_KEY_V2, JSON.stringify(alertState))
  } catch {
    // abaikan
  }
}

function activeAlert(): SingleAlert {
  return alertState.alerts[alertState.active]
}

/** Target default aset: step berikutnya di atas harga saat ini. */
function defaultTarget(coin: AlertCoin, price: number): number {
  const step = ALERT_STEP[coin]
  return (Math.floor(price / step) + 1) * step
}

const ALERT_ORDER: AlertCoin[] = ['BTC', 'ETH', 'SOL']

function cycleAlertAsset(): void {
  const idx = ALERT_ORDER.indexOf(alertState.active)
  alertState.active = ALERT_ORDER[(idx + 1) % ALERT_ORDER.length]
  saveAlert()
  render()
}

let transientMsg = ''
let transientTimer: ReturnType<typeof setTimeout> | null = null

function showTransient(msg: string): void {
  transientMsg = msg
  render()
  if (transientTimer) clearTimeout(transientTimer)
  transientTimer = setTimeout(() => {
    transientMsg = ''
    transientTimer = null
    render()
  }, 3000)
}

// ---------- voice (push-to-talk, Groq Whisper) ----------
// audioEvent simulator: 100 ms @16 kHz s16le = 3.200 byte/event.
// Rekaman maks 10 detik (320.000 byte) lalu auto-stop & kirim.
const VOICE_MAX_MS = 10000
const VOICE_MIN_BYTES = 9600 // ~0,3 detik - lebih pendek dari ini dianggap tidak sengaja
type VoicePhase = 'idle' | 'listening' | 'sending' | 'result'
let voicePhase: VoicePhase = 'idle'
let voiceChunks: Uint8Array[] = []
let voiceBytes = 0
let voiceStartedAt = 0
let voiceLevel = 0
let voiceLastText = ''
let voiceLastResult = ''
let voiceTimer: ReturnType<typeof setTimeout> | null = null
let voiceLastRender = 0

function voiceElapsedSec(): number {
  return (Date.now() - voiceStartedAt) / 1000
}

function concatPcm(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

function clearVoiceTimer(): void {
  if (voiceTimer) { clearTimeout(voiceTimer); voiceTimer = null }
}

async function stopMic(): Promise<void> {
  try { await bridge.audioControl(false) } catch { /* abaikan */ }
}

function voiceResult(text: string, result: string): void {
  voicePhase = 'result'
  voiceLastText = text
  voiceLastResult = result
  render()
}

async function startListening(): Promise<void> {
  if (voicePhase === 'listening' || voicePhase === 'sending') return
  if (!getGroqKey()) {
    voiceResult('', 'NO GROQ KEY - see settings')
    return
  }
  let ok = false
  try {
    ok = await bridge.audioControl(true)
  } catch (e) {
    console.log('voice audioControl(true) threw:', e)
  }
  if (!ok) {
    voiceResult('', 'MIC FAILED - try again')
    return
  }
  voicePhase = 'listening'
  voiceChunks = []
  voiceBytes = 0
  voiceLevel = 0
  voiceStartedAt = Date.now()
  voiceLastRender = 0
  console.log('voice listening started')
  clearVoiceTimer()
  voiceTimer = setTimeout(() => { void stopListening(true) }, VOICE_MAX_MS)
  render()
}

async function stopListening(send: boolean): Promise<void> {
  if (voicePhase !== 'listening') return
  clearVoiceTimer()
  const chunks = voiceChunks
  const bytes = voiceBytes
  voiceChunks = []
  voiceBytes = 0
  voicePhase = 'idle'
  await stopMic()
  if (!send) {
    console.log('voice listening cancelled')
    render()
    return
  }
  if (bytes < VOICE_MIN_BYTES) {
    voiceResult('', 'TOO SHORT - hold longer')
    return
  }
  const key = getGroqKey()
  if (!key) {
    voiceResult('', 'NO GROQ KEY - see settings')
    return
  }
  voicePhase = 'sending'
  render()
  console.log(`voice sending ${bytes} bytes to groq`)
  const text = await transcribePcm(concatPcm(chunks), key)
  if (text === null) {
    voiceResult('', 'STT FAILED - check key + net')
    return
  }
  if (text === '') {
    voiceResult('', 'HEARD NOTHING - try again')
    return
  }
  handleVoiceTranscript(text)
}

/** Jalankan satu perintah (hasil STT / chips settings / debug) + tampilkan hasil. */
function handleVoiceTranscript(text: string): void {
  const action: VoiceAction | null = parseVoiceCommand(text)
  console.log('voice transcript:', JSON.stringify(text), '->', JSON.stringify(action))
  if (!action) {
    voiceResult(text, 'NOT UNDERSTOOD - try again')
    return
  }
  const result = executeVoiceAction(action)
  voiceResult(text, result)
  // Perintah pindah view: hasil tampil dulu di view VOICE, baru pindah.
  // (executeVoiceAction sengaja TIDAK pindah view sendiri.)
  if (action.type === 'goto' || action.type === 'next' || action.type === 'back') {
    setTimeout(() => {
      if (voicePhase !== 'result') return
      voicePhase = 'idle'
      if (action.type === 'goto') {
        view = action.view
      } else if (action.type === 'next') {
        const idx = VIEW_ORDER.indexOf(view)
        view = VIEW_ORDER[(idx + 1) % VIEW_ORDER.length]
      } else {
        const idx = VIEW_ORDER.indexOf(view)
        view = VIEW_ORDER[(idx - 1 + VIEW_ORDER.length) % VIEW_ORDER.length]
      }
      render()
    }, 1200)
  }
}

function executeVoiceAction(action: VoiceAction): string {
  switch (action.type) {
    case 'stop':
      return 'STOPPED'
    case 'refresh':
      void refreshAll()
      return 'REFRESHED'
    case 'next':
      // Pindah view dilakukan handleVoiceTranscript setelah hasil tampil.
      return 'NEXT VIEW'
    case 'back':
      return 'PREV VIEW'
    case 'goto': {
      return `OPENING ${action.view.toUpperCase()}`
    }
    case 'buy':
      return buyCoin(action.coin)
    case 'sell':
      return sellCoin(action.coin)
    case 'sell-all':
      return sellAllCoin(action.coin)
    case 'set-alert':
      return setAlertTarget(action.target, action.coin)
    case 'cancel-alert':
      return cancelActiveAlert()
  }
}

// ---------- label odds: singkat tapi BERBEDA per pasar ----------
// "Will Bitcoin dip to $55,000 in November?" -> "BTC dip $55,000? YES 48%"
// "Will Ethereum reach $2,000 by...?"      -> "ETH reach $2,000? YES 7%"
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

function shortOddsLabel(question: string, yesPct: number): string {
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

// ---------- render ----------
function paperLines(sym: 'BTC' | 'ETH'): string[] {
  const price = prices ? (sym === 'BTC' ? prices.btc : prices.eth) : 0
  const chg = prices ? (sym === 'BTC' ? prices.btcChg : prices.ethChg) : 0
  const holding = sym === 'BTC' ? paper.btc : paper.eth
  const btcVal = paper.btc * (prices ? prices.btc : 0)
  const ethVal = paper.eth * (prices ? prices.eth : 0)
  const total = paper.cash + btcVal + ethVal
  const pl = total - 10000
  const plStr = `${pl >= 0 ? '+' : '-'}${fmtUsd(Math.abs(pl))}`
  const next = sym === 'BTC' ? 'paper-eth' : 'alerts'
  return [
    `PAPER ${sym} - virtual $10,000`,
    `cash ${fmtUsd(paper.cash)}`,
    `${sym} ${holding.toFixed(4)} = ${fmtUsd(holding * price)}  ${prices ? fmtChg(chg) : ''}`,
    `total ${fmtUsd(total)}  P/L ${plStr}`,
    `up: buy $100 ${sym}`,
    `dn: sell $100 ${sym}`,
    `tap: ${next} >`,
  ]
}

function voiceLines(): string[] {
  if (voicePhase === 'listening') {
    const filled = Math.round(voiceLevel * 10)
    const bar = `[${'#'.repeat(filled)}${'-'.repeat(10 - filled)}]`
    return [
      'VOICE - listening...',
      `lvl ${bar}`,
      `${voiceElapsedSec().toFixed(1)}s up: stop+send`,
      'dn: cancel',
    ]
  }
  if (voicePhase === 'sending') {
    return [
      'VOICE - sending...',
      'transcribing...',
      'please wait',
    ]
  }
  if (voicePhase === 'result') {
    const lines = ['VOICE - heard:']
    if (voiceLastText) {
      const t = truncate(voiceLastText, 32)
      lines.push(`"${t}"`)
    }
    lines.push(`-> ${truncate(voiceLastResult, 31)}`)
    lines.push('up: listen again')
    lines.push('dn: back to idle')
    lines.push('tap: ticker >')
    return lines
  }
  // idle
  if (!getGroqKey()) {
    return [
      'VOICE - push to talk',
      'no groq key set',
      'set key in phone',
      'settings page',
      'up: listen (needs key)',
      'tap: ticker >',
    ]
  }
  return [
    'VOICE - push to talk',
    'say: sell all bitcoin',
    'say: show portfolio',
    'say: cancel alert',
    'up: start listening',
    'dn: back to alerts',
    'tap: ticker >',
  ]
}

function buildContent(): string {
  if (transientMsg) {
    return `PAPER - virtual $10,000\n${transientMsg}`
  }

  if (view === 'ticker') {
    if (!prices) return 'POLYGLANCE\nloading prices...\ntap: odds >'
    return [
      'POLYGLANCE',
      `BTC ${fmtCoinPrice('BTC', prices.btc)}  ${fmtChg(prices.btcChg)}`,
      `ETH ${fmtCoinPrice('ETH', prices.eth)}  ${fmtChg(prices.ethChg)}`,
      `SOL ${fmtCoinPrice('SOL', prices.sol)}  ${fmtChg(prices.solChg)}`,
      `DOGE ${fmtCoinPrice('DOGE', prices.doge)}  ${fmtChg(prices.dogeChg)}`,
      `XRP ${fmtCoinPrice('XRP', prices.xrp)}  ${fmtChg(prices.xrpChg)}`,
      offline ? 'OFFLINE - last data' : `updated ${lastUpdated}`,
      'tap: odds >',
    ].join('\n')
  }

  if (view === 'odds') {
    if (markets.length === 0) return 'ODDS - POLYMARKET\nloading markets...\ntap: paper-btc >'
    const page = markets.slice(oddsPage * 3, oddsPage * 3 + 3)
    const lines = ['ODDS - POLYMARKET']
    for (const m of page) {
      lines.push(shortOddsLabel(m.question, m.yesPct))
    }
    lines.push('data: polymarket')
    lines.push('tap: paper-btc >')
    return lines.join('\n')
  }

  if (view === 'paper-btc') return paperLines('BTC').join('\n')
  if (view === 'paper-eth') return paperLines('ETH').join('\n')

  if (view === 'alerts') {
    const coin = alertState.active
    const a = activeAlert()
    const price = prices ? priceOf(coin) : 0
    const targetLine = a.target > 0
      ? `target ${fmtCoinPrice(coin, a.target)}`
      : 'target: not set'
    const statusLine = a.triggered
      ? `${coin} HIT ${fmtCoinPrice(coin, a.target)}!`
      : a.armed
        ? 'status: WAITING'
        : 'status: OFF'
    return [
      `ALERTS - ${coin}`,
      targetLine,
      statusLine,
      prices ? `now ${fmtCoinPrice(coin, price)}` : 'now: loading...',
      `up: +${fmtCoinPrice(coin, ALERT_STEP[coin])}  dn: -${fmtCoinPrice(coin, ALERT_STEP[coin])}`,
      'dbl-tap: next coin',
      'TG: @polyglance_alerts_bot',
      'tap: voice >',
    ].join('\n')
  }

  // voice
  return voiceLines().join('\n')
}

function render(): void {
  bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,
      containerName: 'main',
      content: buildContent(),
    }),
  )
}

// ---------- data ----------
async function fetchPrices(): Promise<void> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,dogecoin,ripple&vs_currencies=usd&include_24hr_change=true',
    )
    console.log('coingecko status:', res.status)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const btc = data?.bitcoin
    const eth = data?.ethereum
    const sol = data?.solana
    const doge = data?.dogecoin
    const xrp = data?.ripple
    if (!btc || !eth || !sol || !doge || !xrp) throw new Error('bad payload')
    prices = {
      btc: Number(btc.usd),
      eth: Number(eth.usd),
      sol: Number(sol.usd),
      doge: Number(doge.usd),
      xrp: Number(xrp.usd),
      btcChg: Number(btc.usd_24h_change),
      ethChg: Number(eth.usd_24h_change),
      solChg: Number(sol.usd_24h_change),
      dogeChg: Number(doge.usd_24h_change),
      xrpChg: Number(xrp.usd_24h_change),
    }
    console.log('coingecko data:', data)
    lastUpdated = fmtTime(new Date())
    offline = false
    // Target default: step berikutnya di atas harga saat ini, per aset.
    // Hanya sekali (seeded=false, instalasi baru) — alert yang sengaja
    // di-cancel (target 0) TIDAK dibuat ulang diam-diam.
    if (!alertState.seeded) {
      for (const coin of ALERT_ORDER) {
        const a = alertState.alerts[coin]
        if (a.target === 0) {
          a.target = defaultTarget(coin, priceOf(coin))
          a.armed = true
          a.triggered = false
        }
      }
      alertState.seeded = true
    }
    saveAlert()
  } catch (err) {
    console.log('coingecko fetch failed:', err)
    offline = true
  }
}

// Gamma mengirim outcomes + outcomePrices sebagai STRING JSON,
// mis. '["Yes", "No"]' dan '["0.65", "0.35"]' - harus di-parse dulu.
// Harga YES dicari lewat nama outcome, bukan index tetap.
function parseStrArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string') {
    try {
      const p: unknown = JSON.parse(v)
      if (Array.isArray(p)) return p.map(String)
    } catch {
      return []
    }
  }
  return []
}

function yesPricePct(outcomes: unknown, prices: unknown): number {
  const oc = parseStrArr(outcomes)
  const pr = parseStrArr(prices)
  if (pr.length === 0) return 0
  const idx = oc.findIndex((o) => o.toLowerCase() === 'yes')
  const p = parseFloat(pr[idx >= 0 ? idx : 0] ?? '0')
  return Math.round((Number.isFinite(p) ? p : 0) * 100)
}

async function fetchOdds(): Promise<void> {
  try {
    // order=volume24hr desc: pasar crypto (volume harian besar) naik ke atas.
    // limit=100 = batas maks API; tag_slug terbukti tidak memfilter di /markets.
    const res = await fetch('https://gamma-api.polymarket.com/markets?limit=100&active=true&closed=false&order=volume24hr&ascending=false')
    console.log('gamma status:', res.status)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const arr: unknown[] = Array.isArray(data) ? data : (data?.markets ?? [])
    // \b supaya "eth" tidak cocok di tengah kata (mis. "Hegseth")
    const keyword = /\b(bitcoin|btc|ethereum|eth|crypto|solana)\b/i
    const parsed: Market[] = arr
      .map((m) => {
        const rec = m as { question?: unknown; outcomes?: unknown; outcomePrices?: unknown; volume24hr?: unknown }
        return {
          question: String(rec.question ?? ''),
          yesPct: yesPricePct(rec.outcomes, rec.outcomePrices),
          vol24h: parseFloat(String(rec.volume24hr ?? '0')),
        }
      })
      .filter((m) => m.question.length > 0)
      .sort((a, b) => b.vol24h - a.vol24h)
    const filtered = parsed.filter((m) => keyword.test(m.question))
    markets = filtered.length >= 3
      ? filtered
      : [...filtered, ...parsed.filter((m) => !filtered.includes(m))].slice(0, 3)
    console.log('gamma markets:', markets.length)
  } catch (err) {
    console.log('gamma fetch failed:', err)
  }
}

// Alert menyala saat harga aset mencapai/melewati targetnya.
// Dicek semua aset yang di-arm; yang pertama kena (urutan BTC, ETH, SOL)
// jadi aset aktif dan view lompat ke ALERTS.
// (Target yang diset di bawah harga saat ini langsung trigger —
//  harga sudah melewatinya.)
function checkAlert(): void {
  if (!prices) return
  for (const coin of ALERT_ORDER) {
    const a = alertState.alerts[coin]
    if (!a.armed || a.triggered || a.target === 0) continue
    if (priceOf(coin) >= a.target) {
      a.triggered = true
      saveAlert()
      alertState.active = coin
      saveAlert()
      // Auto-pindah ke view ALERTS sekali saat trigger.
      if (view !== 'alerts') {
        view = 'alerts'
      }
      render()
      return
    }
  }
}

async function refreshAll(): Promise<void> {
  await fetchPrices()
  await fetchOdds()
  checkAlert()
  render()
}

// ---------- page + events ----------
const mainText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 1,
  containerName: 'main',
  content: buildContent(),
  isEventCapture: 1,
})

const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [mainText],
  }),
)

console.log('Page created:', result === 0 ? 'success' : `failed (${result})`)

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

const VIEW_ORDER: View[] = ['ticker', 'odds', 'paper-btc', 'paper-eth', 'alerts', 'voice']

function cancelListeningSync(): void {
  // Dipanggil saat pindah view / keluar: matikan mic, buang rekaman.
  if (voicePhase === 'listening' || voicePhase === 'sending') {
    clearVoiceTimer()
    voiceChunks = []
    voiceBytes = 0
    voicePhase = 'idle'
    void stopMic()
  } else if (voicePhase === 'result') {
    voicePhase = 'idle'
  }
}

function nextView(): void {
  if (transientMsg) {
    transientMsg = ''
    if (transientTimer) { clearTimeout(transientTimer); transientTimer = null }
  }
  cancelListeningSync()
  const idx = VIEW_ORDER.indexOf(view)
  view = VIEW_ORDER[(idx + 1) % VIEW_ORDER.length]
  render()
}

function prevView(): void {
  if (transientMsg) {
    transientMsg = ''
    if (transientTimer) { clearTimeout(transientTimer); transientTimer = null }
  }
  cancelListeningSync()
  const idx = VIEW_ORDER.indexOf(view)
  view = VIEW_ORDER[(idx - 1 + VIEW_ORDER.length) % VIEW_ORDER.length]
  render()
}

function buyCoin(sym: 'BTC' | 'ETH'): string {
  if (!prices) return 'NO PRICE YET'
  if (paper.cash < 100) return 'NOT ENOUGH CASH'
  const price = sym === 'BTC' ? prices.btc : prices.eth
  if (sym === 'BTC') paper.btc += 100 / price
  else paper.eth += 100 / price
  paper.cash -= 100
  savePaper()
  render()
  return `BOUGHT $100 ${sym}`
}

function sellCoin(sym: 'BTC' | 'ETH'): string {
  if (!prices) return 'NO PRICE YET'
  const price = sym === 'BTC' ? prices.btc : prices.eth
  const holding = sym === 'BTC' ? paper.btc : paper.eth
  if (holding * price < 100) return sym === 'BTC' ? 'NOT ENOUGH BTC' : 'NOT ENOUGH ETH'
  if (sym === 'BTC') paper.btc -= 100 / price
  else paper.eth -= 100 / price
  paper.cash += 100
  savePaper()
  render()
  return `SOLD $100 ${sym}`
}

function setAlertTarget(target: number, coin?: AlertCoin): string {
  if (!prices) return 'NO PRICE YET'
  const c: AlertCoin = coin ?? alertState.active
  if (target < ALERT_MIN[c]) return `TARGET TOO LOW (min ${fmtCoinPrice(c, ALERT_MIN[c])})`
  const a = alertState.alerts[c]
  a.target = Math.round(target)
  a.armed = true
  a.triggered = false
  alertState.active = c
  saveAlert()
  // Cek trigger tanpa auto-pindah view (hasil suara harus tampil dulu).
  if (priceOf(c) >= a.target) {
    a.triggered = true
    saveAlert()
    render()
    return `ALERT ${c} ${fmtCoinPrice(c, a.target)} HIT!`
  }
  render()
  return `ALERT SET ${c} ${fmtCoinPrice(c, a.target)}`
}

function adjustAlert(steps: number): void {
  if (!prices) { showTransient('NO PRICE YET'); return }
  const coin = alertState.active
  const a = activeAlert()
  const step = ALERT_STEP[coin]
  if (a.target === 0) {
    a.target = defaultTarget(coin, priceOf(coin))
  }
  a.target = Math.max(ALERT_MIN[coin], a.target + steps * step)
  a.armed = true
  a.triggered = false
  saveAlert()
  checkAlert()
  render()
}

/** Jual SEMUA holding: satu koin, atau BTC+ETH sekaligus ('ALL'). */
function sellAllCoin(coin: 'BTC' | 'ETH' | 'ALL'): string {
  if (!prices) return 'NO PRICE YET'
  const sold: string[] = []
  const sellOne = (sym: 'BTC' | 'ETH'): void => {
    const holding = sym === 'BTC' ? paper.btc : paper.eth
    const price = sym === 'BTC' ? prices!.btc : prices!.eth
    if (holding > 0) {
      paper.cash += holding * price
      if (sym === 'BTC') paper.btc = 0
      else paper.eth = 0
      sold.push(sym)
    }
  }
  if (coin === 'ALL') {
    sellOne('BTC')
    sellOne('ETH')
  } else {
    sellOne(coin)
  }
  if (sold.length === 0) return 'NOTHING TO SELL'
  savePaper()
  render()
  return sold.length === 2 ? 'SOLD ALL BTC+ETH' : `SOLD ALL ${sold[0]}`
}

/** Hapus alert aset aktif (target + armed + triggered direset). */
function cancelActiveAlert(): string {
  const coin = alertState.active
  const a = activeAlert()
  if (a.target === 0 && !a.armed && !a.triggered) return 'NO ALERT SET'
  alertState.alerts[coin] = blankAlert()
  saveAlert()
  render()
  return `ALERT ${coin} REMOVED`
}

function swipeUp(): void {
  if (view === 'voice') {
    if (voicePhase === 'idle') { void startListening(); return }
    if (voicePhase === 'listening') { void stopListening(true); return }
    if (voicePhase === 'result') { voicePhase = 'idle'; void startListening(); return }
    return
  }
  if (view === 'ticker') { void refreshAll(); return }
  if (view === 'odds') {
    const pages = Math.max(1, Math.ceil(markets.length / 3))
    oddsPage = (oddsPage - 1 + pages) % pages
    render()
    return
  }
  if (view === 'alerts') { adjustAlert(1); return }
  const msg = buyCoin(view === 'paper-btc' ? 'BTC' : 'ETH')
  if (!msg.startsWith('BOUGHT')) showTransient(msg)
}

function swipeDown(): void {
  if (view === 'voice') {
    if (voicePhase === 'listening') { void stopListening(false); return }
    if (voicePhase === 'result') { voicePhase = 'idle'; render(); return }
    prevView()
    return
  }
  if (view === 'ticker') { void refreshAll(); return }
  if (view === 'odds') {
    const pages = Math.max(1, Math.ceil(markets.length / 3))
    oddsPage = (oddsPage + 1) % pages
    render()
    return
  }
  if (view === 'alerts') { adjustAlert(-1); return }
  const msg = sellCoin(view === 'paper-btc' ? 'BTC' : 'ETH')
  if (!msg.startsWith('SOLD')) showTransient(msg)
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  // Audio dari mic kacamata: akumulasi PCM selama fase listening.
  const pcm = event.audioEvent?.audioPcm
  if (pcm && voicePhase === 'listening') {
    voiceChunks.push(pcm)
    voiceBytes += pcm.length
    voiceLevel = rmsLevel(pcm)
    // Render meter secukupnya (tiap ~300 ms) supaya tidak membanjiri bridge.
    const now = Date.now()
    if (now - voiceLastRender > 300) {
      voiceLastRender = now
      render()
    }
    return
  }

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    // Di view ALERTS, double-tap = ganti aset alert (BTC -> ETH -> SOL).
    // SDK tidak punya gesture swipe kiri/kanan; double-tap adalah satu-satunya
    // gesture diskrit yang bebas di view ini. Di view lain tetap keluar.
    if (view === 'alerts') {
      cycleAlertAsset()
      return
    }
    cancelListeningSync()
    bridge.shutDownPageContainer(1)
    return
  }

  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    nextView()
    return
  }

  if (sysType === OsEventTypeList.SCROLL_TOP_EVENT || textType === OsEventTypeList.SCROLL_TOP_EVENT) {
    swipeUp()
    return
  }

  if (sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT || textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    swipeDown()
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cancelListeningSync()
    unsubscribe()
  }
})

// ---------- debug + settings: perintah suara tanpa mic ----------
// Halaman settings di HP (index.html) mengirim CustomEvent
// 'polyglance-voice-cmd' {detail:{text}} — jalankan parser yang sama.
// ?debugvoice=<teks> di URL = jalur debug simulator: otomatis jalankan
// transcript itu sekali saat start (tanpa mic, tanpa key Groq).
window.addEventListener('polyglance-voice-cmd', ((e: CustomEvent<{ text: string }>) => {
  const text = e.detail?.text
  if (typeof text === 'string' && text.trim()) {
    view = 'voice'
    handleVoiceTranscript(text)
  }
}) as EventListener)

// Hook debug untuk konsol WebView.
;(window as unknown as { __pgVoiceDebug: (t: string) => void }).__pgVoiceDebug = (t: string) => {
  view = 'voice'
  handleVoiceTranscript(t)
}

// ---------- start: isi data lalu auto-refresh 60 detik ----------
await refreshAll()
setInterval(() => { void refreshAll() }, 60000)

// Debug simulator: ?debugkey=1 pasang key DUMMY ke localStorage supaya jalur
// mic bisa dites tanpa key asli (STT akan gagal 401 -> 'STT FAILED', itu yang
// diharapkan). ?debugkey=clear menghapusnya lagi. TIDAK PERNAH dipakai di HP.
try {
  const dk = new URLSearchParams(window.location.search).get('debugkey')
  if (dk === '1') {
    try { localStorage.setItem(GROQ_KEY_STORAGE, 'DEBUG_KEY_FOR_SIMULATOR_TEST') } catch { /* abaikan */ }
    console.log('voice debug: dummy key installed (simulator only)')
  } else if (dk === 'clear') {
    try { localStorage.removeItem(GROQ_KEY_STORAGE) } catch { /* abaikan */ }
    console.log('voice debug: dummy key cleared')
  }
} catch {
  // abaikan - URL tidak bisa dibaca
}

// Debug simulator: ?debugvoice=buy%20one%20hundred%20bitcoin
try {
  const dbg = new URLSearchParams(window.location.search).get('debugvoice')
  if (dbg) {
    console.log('voice debug param:', dbg)
    setTimeout(() => {
      view = 'voice'
      handleVoiceTranscript(decodeURIComponent(dbg))
    }, 1500)
  }
} catch {
  // abaikan - URL tidak bisa dibaca
}

// Log status key (hanya ada/tidak, JANGAN PERNAH log nilai key).
console.log('voice groq key set:', getGroqKey() !== null, '| storage key:', GROQ_KEY_STORAGE)
