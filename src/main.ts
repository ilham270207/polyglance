// PolyGlance v4 - 5 view + paper trade BTC/ETH + price alert
// Tap = pindah view (TICKER -> ODDS -> PAPER-BTC -> PAPER-ETH -> ALERTS -> TICKER).
// Double-tap = keluar. Swipe up/down = aksi per view.
// Semua teks ASCII saja. Satu container 576x288, isEventCapture: 1.

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

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
type View = 'ticker' | 'odds' | 'paper-btc' | 'paper-eth' | 'alerts'
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

  // alerts
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
    'tap: ticker >',
  ].join('\n')
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

const VIEW_ORDER: View[] = ['ticker', 'odds', 'paper-btc', 'paper-eth', 'alerts']

function nextView(): void {
  if (transientMsg) {
    transientMsg = ''
    if (transientTimer) { clearTimeout(transientTimer); transientTimer = null }
  }
  const idx = VIEW_ORDER.indexOf(view)
  view = VIEW_ORDER[(idx + 1) % VIEW_ORDER.length]
  render()
}

function buyCoin(sym: 'BTC' | 'ETH'): void {
  if (!prices) { showTransient('NO PRICE YET'); return }
  if (paper.cash < 100) { showTransient('NOT ENOUGH CASH'); return }
  const price = sym === 'BTC' ? prices.btc : prices.eth
  if (sym === 'BTC') paper.btc += 100 / price
  else paper.eth += 100 / price
  paper.cash -= 100
  savePaper()
  render()
}

function sellCoin(sym: 'BTC' | 'ETH'): void {
  if (!prices) { showTransient('NO PRICE YET'); return }
  const price = sym === 'BTC' ? prices.btc : prices.eth
  const holding = sym === 'BTC' ? paper.btc : paper.eth
  if (holding * price < 100) { showTransient(sym === 'BTC' ? 'NOT ENOUGH BTC' : 'NOT ENOUGH ETH'); return }
  if (sym === 'BTC') paper.btc -= 100 / price
  else paper.eth -= 100 / price
  paper.cash += 100
  savePaper()
  render()
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
  if (view === 'ticker') { void refreshAll(); return }
  if (view === 'odds') {
    const pages = Math.max(1, Math.ceil(markets.length / 3))
    oddsPage = (oddsPage - 1 + pages) % pages
    render()
    return
  }
  if (view === 'alerts') { adjustAlert(1000); return }
  buyCoin(view === 'paper-btc' ? 'BTC' : 'ETH')
}

function swipeDown(): void {
  if (view === 'ticker') { void refreshAll(); return }
  if (view === 'odds') {
    const pages = Math.max(1, Math.ceil(markets.length / 3))
    oddsPage = (oddsPage + 1) % pages
    render()
    return
  }
  if (view === 'alerts') { adjustAlert(-1000); return }
  sellCoin(view === 'paper-btc' ? 'BTC' : 'ETH')
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
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
    unsubscribe()
  }
})

// ---------- start: isi data lalu auto-refresh 60 detik ----------
await refreshAll()
setInterval(() => { void refreshAll() }, 60000)
