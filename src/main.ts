// PolyGlance v5 - 6 view + paper trade BTC/ETH + price alert + VOICE + Telegram
// Tap = pindah view (TICKER -> ODDS -> PAPER-BTC -> PAPER-ETH -> ALERTS -> VOICE -> TICKER).
// Double-tap = keluar. Swipe up/down = aksi per view.
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
import { parseVoiceCommand, rmsLevel, type VoiceAction } from './voice'
import { transcribePcm, getGroqKey, GROQ_KEY_STORAGE } from './stt'

const bridge = await waitForEvenAppBridge()

// ---------- helpers format ----------
function fmtUsd(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
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

interface Prices { btc: number; eth: number; btcChg: number; ethChg: number }
let prices: Prices | null = null
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

// ---------- price alert (BTC) ----------
// Alert "naik ke target": menyala saat harga BTC mencapai/melewati target.
// Target default selalu DI ATAS harga saat ini (ribuan berikutnya) supaya
// tidak langsung trigger saat pertama kali diset.
const ALERT_KEY = 'polyglance.alert.v1'
interface AlertState { target: number; armed: boolean; triggered: boolean }

function loadAlert(): AlertState {
  try {
    const raw = localStorage.getItem(ALERT_KEY)
    if (raw) {
      const a = JSON.parse(raw) as Partial<AlertState>
      if (typeof a.target === 'number') {
        return {
          target: a.target,
          armed: a.armed === true,
          triggered: a.triggered === true,
        }
      }
    }
  } catch {
    // abaikan - mulai tanpa target
  }
  return { target: 0, armed: false, triggered: false }
}

let alertState: AlertState = loadAlert()

function saveAlert(): void {
  try {
    localStorage.setItem(ALERT_KEY, JSON.stringify(alertState))
  } catch {
    // abaikan
  }
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
    case 'set-alert':
      return setAlertTarget(action.target)
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
    'say: buy 100 bitcoin',
    'say: set alert 58000',
    'say: show odds',
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
      `BTC ${fmtUsd(prices.btc)}  ${fmtChg(prices.btcChg)}`,
      `ETH ${fmtUsd(prices.eth)}  ${fmtChg(prices.ethChg)}`,
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
    const targetLine = alertState.target > 0
      ? `target ${fmtUsd(alertState.target)}`
      : 'target: not set'
    const statusLine = alertState.triggered
      ? `BTC HIT ${fmtUsd(alertState.target)}!`
      : alertState.armed
        ? 'status: WAITING'
        : 'status: OFF'
    return [
      'ALERTS - BTC price',
      targetLine,
      statusLine,
      prices ? `now ${fmtUsd(prices.btc)}` : 'now: loading...',
      'up: +$1,000  dn: -$1,000',
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
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true',
    )
    console.log('coingecko status:', res.status)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const btc = data?.bitcoin
    const eth = data?.ethereum
    if (!btc || !eth) throw new Error('bad payload')
    prices = {
      btc: Number(btc.usd),
      eth: Number(eth.usd),
      btcChg: Number(btc.usd_24h_change),
      ethChg: Number(eth.usd_24h_change),
    }
    console.log('coingecko data:', data)
    lastUpdated = fmtTime(new Date())
    offline = false
    // Target default: ribuan berikutnya di atas harga saat ini.
    if (alertState.target === 0) {
      alertState.target = (Math.floor(prices.btc / 1000) + 1) * 1000
      alertState.armed = true
      alertState.triggered = false
      saveAlert()
    }
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

// Alert menyala saat harga BTC mencapai/melewati target.
// (Target yang diset di bawah harga saat ini langsung trigger -
//  harga sudah melewatinya.)
function checkAlert(): void {
  if (!prices || !alertState.armed || alertState.triggered || alertState.target === 0) return
  if (prices.btc >= alertState.target) {
    alertState.triggered = true
    saveAlert()
    // Auto-pindah ke view ALERTS sekali saat trigger.
    if (view !== 'alerts') {
      view = 'alerts'
    }
    render()
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

function setAlertTarget(target: number): string {
  if (!prices) return 'NO PRICE YET'
  alertState.target = Math.max(1000, Math.round(target))
  alertState.armed = true
  alertState.triggered = false
  saveAlert()
  // Cek trigger tanpa auto-pindah view (hasil suara harus tampil dulu).
  if (prices.btc >= alertState.target) {
    alertState.triggered = true
    saveAlert()
    render()
    return `ALERT ${fmtUsd(alertState.target)} HIT!`
  }
  render()
  return `ALERT SET ${fmtUsd(alertState.target)}`
}

function adjustAlert(delta: number): void {
  if (!prices) { showTransient('NO PRICE YET'); return }
  if (alertState.target === 0) {
    alertState.target = (Math.floor(prices.btc / 1000) + 1) * 1000
  }
  alertState.target = Math.max(1000, alertState.target + delta)
  alertState.armed = true
  alertState.triggered = false
  saveAlert()
  checkAlert()
  render()
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
  if (view === 'alerts') { adjustAlert(1000); return }
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
  if (view === 'alerts') { adjustAlert(-1000); return }
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
