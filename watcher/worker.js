// PolyGlance watcher — Cloudflare Worker (TARGET UTAMA).
// Cron trigger tiap 1 menit: cek harga CoinGecko -> kirim alert yang crossing.
// Perintah bot masuk INSTAN via webhook Telegram (POST /webhook, dipasang
// sekali lewat GET /setwebhook); cron SKIP polling getUpdates saat webhook
// aktif, tapi tetap jalan untuk harga + alert. Kalau webhook mati, cron
// kembali otomatis ke polling (verifikasi getWebhookInfo ~1 jam sekali).
// Token bot HANYA sebagai Worker secret (wrangler secret put POLYGLANCE_BOT_TOKEN).
// State (offset, alerts, harga terakhir) di KV binding ALERTS_KV.
// Deploy: lihat watcher/README.md. JANGAN commit token ke file mana pun.

import {
  fmtUsd,
  fmtPrice,
  fmtVolume,
  friendlyReply,
  checkAlertCrossings,
  checkOddsAlertCrossings,
  findOddsMarket,
  oddsYesByQuestion,
  topOddsMarkets,
  formatOddsRich,
  formatAlertsList,
  formatAlertLine,
  formatPriceReply,
  formatHealthReply,
  formatAlertSetReply,
  formatOddsAlertSetReply,
  formatRemovedReply,
  myAlerts,
  trackLivePrice,
  pruneLivePrices,
  parseCoinGeckoPrices,
  parseCoinbaseSpot,
  parseCoinbaseStats,
  parseCoinbaseCandles,
  aggregateCandles,
  parseFearGreed,
  parseNewsHeadlines,
  candlesSvg,
  sparklineSvg,
  HELP_TEXT,
  isAskRefusalNeeded,
  ASK_REFUSAL,
  buildAskMessages,
  parseAskAnswer,
  buildAskWebMessages,
  parseAskWebAnswer,
  isValidAskWebQuestion,
  ASK_WEB_RATE_LIMIT_PER_MIN,
  ASK_WEB_CORS_HEADERS,
  parseWhaleTrades,
  formatWhalesReply,
  formatMorningBrief,
  briefDue,
  shouldPersistPrices,
} from './core.mjs'

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd'
const COINBASE_BTC_URL = 'https://api.coinbase.com/v2/prices/BTC-USD/spot'
const COINBASE_ETH_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot'
const COINBASE_SPOT = (sym) => `https://api.coinbase.com/v2/prices/${sym}-USD/spot`
const COINBASE_STATS = (sym) => `https://api.exchange.coinbase.com/products/${sym}-USD/stats`
const COINBASE_CANDLES = (sym, gran) => `https://api.exchange.coinbase.com/products/${sym}-USD/candles?granularity=${gran}`
const FNG_URL = 'https://api.alternative.me/fng/?limit=1'
const PRICE_SYMBOLS = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']
// Timeframe /app. Catatan: 4h TIDAK di-fetch langsung — granularity 14400
// tidak valid di Coinbase Exchange (valid: 60/300/900/3600/21600/86400),
// jadi candle 4h dihitung dari agregasi 4 x candle 1h (aggregateCandles).
const TF_GRANULARITY = { '1h': 3600, '4h': 14400, '1d': 86400 }
const GAMMA_URL =
  'https://gamma-api.polymarket.com/markets?limit=100&active=true&closed=false&order=volume24hr&ascending=false'
const KEY_META = 'polyglance-state-v1' // offset getUpdates, chats, processedUpdateIds (dipakai sejak v1)
const KEY_PRICES = 'polyglance-prices-v1' // lastPrices, lastTick, priceSource, priceError, lastOdds — ditulis HANYA oleh cron
const KEY_ALERTS = 'polyglance-alerts-v1' // alerts, oddsAlerts
const KEY_WEBHOOK = 'polyglance-webhook-v1' // {active, url, setAt, checkedAt, pending} — ditulis HANYA /setwebhook + verifikasi berkala
const KEY_LIVE = 'polyglance-liveprice-v1' // {messages: [{chatId, messageId, sentAt}]} — pesan /price yang terus di-edit tiap tick (30 menit)
const KEY_BRIEF = 'polyglance-brief-v1' // {lastSentDate: 'YYYY-MM-DD'} — guard sekali-per-hari Morning Brief (v8.2)

// --- v8.2: ASK / WHALES / MOOD / Morning Brief ---
// Semua fitur baru TANPA KV, kecuali guard sekali-per-hari Morning Brief
// (1 baca KV di jam 01:00 UTC + 1 tulis/hari — lihat tick §1d).
// /ask + /whales + /fng + /news pakai cache in-memory saja (bukan KV).
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_CHAT_MODEL = 'qwen/qwen3.8-27b'
const ASK_TIMEOUT_MS = 15000
const WHALES_TRADES_URL = 'https://data-api.polymarket.com/v2/trades?limit=100'
const WHALES_CACHE_MS = 45 * 1000 // trade paus bergerak cepat — cache pendek
const FNG_CACHE_MS = 5 * 60 * 1000 // Fear & Greed berubah 1x/hari — cache panjang
const NEWS_FEED_URLS = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://cointelegraph.com/rss',
]
const NEWS_CACHE_MS = 10 * 60 * 1000 // headline berubah tiap menit — cache 10 menit
let askMinuteCount = 0 // batas in-memory: maks 60 pertanyaan ASK per menit per isolate
let askMinuteStart = 0
let askWebMinuteCount = 0 // batas in-memory TERPISAH untuk /ask-web: maks 60/menit per isolate
let askWebMinuteStart = 0
let whalesCache = null // {trades, updatedAt, count}
let whalesCacheAt = 0
let fngCache = null // {value, label, updatedAt}
let fngCacheAt = 0
let newsCache = null // {headlines, source, updatedAt}
let newsCacheAt = 0
let briefCache = { date: null, sentDate: null } // guard Morning Brief di memori (hemat baca KV)

// Kenapa state dipecah 4 key: KV Cloudflare itu eventually consistent —
// satu tick cron yang membaca snapshot lama lalu menyimpan ulang SELURUH
// blob bisa menghapus tulisan terbaru (terbukti 26 Nov 12:28 WIB: flag
// webhook yang baru dipasang hilang dalam 2 menit karena tick membaca
// state lama). Dengan pemisahan ini, tiap key hanya ditulis oleh pemiliknya:
// harga oleh cron saja, flag webhook oleh /setwebhook + verifikasi saja,
// dan tick TIDAK PERNAH menulis key yang bukan miliknya.
// Webhook Telegram: perintah masuk instan via POST /webhook (bukan polling).
// URL ini SATU-SATUNYA yang boleh dipasang /setwebhook — jangan terima URL dari parameter.
const WEBHOOK_URL = 'https://polyglance-watcher.danham322.workers.dev/webhook'

// --- Profil bot Telegram (dipakai route GET /setupbot, sekali-pakai) ---
// Batas Bot API: short_description <= 120 karakter, description <= 512.
// Daftar commands HARUS cocok dengan parseBotCommand() di core.mjs —
// jangan tambah perintah fiktif.
const BOT_SHORT_DESCRIPTION = 'PolyGlance — live crypto prices, Polymarket odds & alerts for Even Realities G2.'
const BOT_DESCRIPTION = [
  'PolyGlance — crypto at a glance on Even Realities G2 smart glasses.',
  '',
  'Live BTC/ETH prices, Polymarket odds, price alerts and odds alerts — plus SOL prices, paper trading and voice commands on the glasses.',
  '',
  'Use /price, /odds, /ask, /whales, /brief, /alert, /alertodds, /list, /remove, /health or /help.',
  '',
  'Build: dorahacks.io/build/51900',
].join('\n')
const BOT_COMMANDS = [
  { command: 'start', description: 'Start PolyGlance alerts' },
  { command: 'price', description: 'Live prices: BTC, ETH, SOL, DOGE & XRP' },
  { command: 'odds', description: 'Top 5 Polymarket crypto odds' },
  { command: 'ask', description: 'Ask the market, e.g. /ask why is bitcoin down?' },
  { command: 'whales', description: 'Big Polymarket crypto trades ($1,000+)' },
  { command: 'brief', description: 'This morning\'s market digest' },
  { command: 'alert', description: 'Set a price alert, e.g. /alert btc above 58000' },
  { command: 'alertodds', description: 'Set an odds alert, e.g. /alertodds btc dip above 60' },
  { command: 'list', description: 'List your alerts' },
  { command: 'remove', description: 'Remove an alert, e.g. /remove 1' },
  { command: 'health', description: 'Check if the watcher is alive' },
  { command: 'help', description: 'Show the full guide' },
]
const MENU_BUTTON = { type: 'web_app', text: 'Open PolyGlance', web_app: { url: 'https://polyglance-watcher.danham322.workers.dev/app' } }
const BUILD_URL = 'https://dorahacks.io/build/51900'
const VIDEO_URL = 'https://www.youtube.com/watch?v=8XkZofCfyzk'

const tg = (token) => `https://api.telegram.org/bot${token}`

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** fetch dengan timeout (AbortSignal.timeout tersedia di Worker + Node 18+). */
async function fetchWithTimeout(url, ms = 5000) {
  return fetch(url, { signal: AbortSignal.timeout(ms) })
}

/** Harga live 5 koin untuk /price: spot Coinbase + stats (perubahan 24 jam).
 * %24h TIDAK PERNAH hilang diam-diam (bug 26 Nov 13:16 WIB: SOL/DOGE tanpa
 * %24h sementara spot lolos semua — stats gagal sebagian di tengah jalan):
 *  1. stats dicoba 1x lagi (jeda 400 ms) kalau gagal/timeout,
 *  2. kalau tetap gagal, %24h dihitung dari candle 1h (open candle pertama
 *     24 jam terakhir -> close candle terakhir, cara yang sama dengan /app),
 *  3. kalau itu pun gagal, formatPriceReply menampilkan "(— 24h)" dengan
 *     jelas (bukan diam-diam hilang).
 * Per koin gagal total (tidak ada harga) -> fallback harga terakhir dari
 * cron (BTC/ETH, ditandai stale) -> kalau tidak ada juga, koin dilewati. */
async function fetchLivePrices(state) {
  const jobs = PRICE_SYMBOLS.map(async (sym) => {
    let price = null
    let changePct = null
    try {
      const res = await fetchWithTimeout(COINBASE_SPOT(sym), 8000)
      if (res.ok) price = parseCoinbaseSpot(await res.json())
    } catch { /* lanjut ke stats / fallback */ }
    const st = await fetchCoinStats(sym)
    if (st) {
      changePct = st.changePct
      if (price === null) price = st.last
    }
    if (changePct === null) changePct = await fetchCandlesChangePct(sym)
    if (price === null && state?.lastPrices) {
      const known = state.lastPrices[sym.toLowerCase()]
      if (typeof known === 'number') return { sym, price: known, changePct, stale: true }
    }
    if (price === null) return null
    return { sym, price, changePct, stale: false }
  })
  return (await Promise.all(jobs)).filter(Boolean)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Stats Coinbase Exchange — 1x retry (jeda 400 ms) kalau gagal. Return
 * objek stats {open, last, high, low, changePct} atau null. */
async function fetchCoinStats(sym) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(COINBASE_STATS(sym), 8000)
      if (res.ok) {
        const st = parseCoinbaseStats(await res.json())
        if (st) return st
      }
    } catch { /* retry sekali */ }
    if (attempt === 0) await sleep(400)
  }
  return null
}

/** %24h dari candle 1h (fallback kalau stats gagal): open candle pertama
 * 24 jam terakhir -> close candle terakhir. */
async function fetchCandlesChangePct(sym) {
  try {
    const res = await fetchWithTimeout(COINBASE_CANDLES(sym, 3600), 8000)
    if (!res.ok) return null
    const candles = parseCoinbaseCandles(await res.json())
    if (!candles || candles.length < 2) return null
    const last24 = candles.slice(-24)
    const first = last24[0]
    const last = last24[last24.length - 1]
    if (!first || !last || first.open <= 0) return null
    return ((last.close - first.open) / first.open) * 100
  } catch {
    return null
  }
}

/** Data 1 koin untuk /app: spot + candle 1 jam (perubahan/high/low/sparkline
 * + array 1h penuh untuk agregasi candle 4h). */
async function fetchCoinData(sym, state) {
  const out = { sym, price: null, changePct: null, high24: null, low24: null, closes: [], candles1h: null, candles1hFull: null, stale: false }
  try {
    const res = await fetchWithTimeout(COINBASE_SPOT(sym), 5000)
    if (res.ok) out.price = parseCoinbaseSpot(await res.json())
  } catch { /* fallback di bawah */ }
  try {
    const res = await fetchWithTimeout(COINBASE_CANDLES(sym, 3600), 5000)
    if (res.ok) {
      const candles = parseCoinbaseCandles(await res.json())
      if (candles) {
        const last24 = candles.slice(-24)
        out.candles1h = last24
        out.candles1hFull = candles
        out.closes = last24.map((c) => c.close)
        out.high24 = Math.max(...last24.map((c) => c.high))
        out.low24 = Math.min(...last24.map((c) => c.low))
        const first = last24[0]
        const last = last24[last24.length - 1]
        if (first && last && first.open > 0) out.changePct = ((last.close - first.open) / first.open) * 100
        if (out.price === null) out.price = last.close
      }
    }
  } catch { /* fallback stats */ }
  if (out.changePct === null || out.high24 === null) {
    try {
      const res = await fetchWithTimeout(COINBASE_STATS(sym), 5000)
      if (res.ok) {
        const st = parseCoinbaseStats(await res.json())
        if (st) {
          if (out.changePct === null) out.changePct = st.changePct
          if (out.high24 === null) out.high24 = st.high
          if (out.low24 === null) out.low24 = st.low
          if (out.price === null) out.price = st.last
        }
      }
    } catch { /* tidak ada */ }
  }
  if (out.price === null && state?.lastPrices) {
    const known = state.lastPrices[sym.toLowerCase()]
    if (typeof known === 'number') { out.price = known; out.stale = true }
  }
  return out
}

/** Dashboard read-only (GET /app) — TEMA PUTIH, mobile-first, tanpa secret.
 * Satu script kecil di <head>: kalau window.Telegram.WebApp TIDAK ada
 * (WebView polos = APK), <html> dapat class native-mode → layout gaya
 * aplikasi Android (app bar + bottom nav, tema gelap). Di dalam Telegram
 * (WebApp ada) tampilannya PERSIS seperti sebelumnya — semua CSS native
 * di-scope ke html.native-mode. Bagian: header status, Fear & Greed, live
 * prices 5 koin + sparkline, top movers, candles (5 koin + timeframe via
 * ?coin=&tf=), top 5 odds + countdown, active alerts kaya, links (TANPA
 * link repo). Kalau satu sumber gagal, bagiannya tampil "unavailable"
 * kecil — halaman lain tetap jalan. */
async function handleApp(env, url) {
  const state = await loadAllCached(env.ALERTS_KV) // cache 90 detik + fallback basi (hemat KV)
  const coin = (url.searchParams.get('coin') || 'BTC').toUpperCase()
  const tf = TF_GRANULARITY[url.searchParams.get('tf')] ? url.searchParams.get('tf') : '1h'
  const selCoin = PRICE_SYMBOLS.includes(coin) ? coin : 'BTC'

  const [coinRows, gammaRes, fngRes, candleRes] = await Promise.allSettled([
    Promise.all(PRICE_SYMBOLS.map((s) => fetchCoinData(s, state))),
    fetchWithTimeout(GAMMA_URL, 5000).then(async (r) => (r.ok ? r.json() : null)).catch(() => null),
    fetchWithTimeout(FNG_URL, 5000).then(async (r) => (r.ok ? r.json() : null)).catch(() => null),
    // Hanya 1d yang di-fetch langsung (granularity 86400 valid). 4h dihitung
    // dari candle 1h (lihat di bawah) — 14400 TIDAK valid di Coinbase.
    tf === '1d'
      ? fetchWithTimeout(COINBASE_CANDLES(selCoin, 86400), 5000)
        .then(async (r) => (r.ok ? parseCoinbaseCandles(await r.json()) : null))
        .catch(() => null)
      : Promise.resolve(null),
  ])
  const coins = coinRows.status === 'fulfilled' ? coinRows.value : []
  const bySym = Object.fromEntries(coins.map((c) => [c.sym, c]))
  const gammaArr = gammaRes.status === 'fulfilled' && gammaRes.value
    ? (Array.isArray(gammaRes.value) ? gammaRes.value : gammaRes.value?.markets ?? [])
    : []
  const fng = fngRes.status === 'fulfilled' ? parseFearGreed(fngRes.value) : null

  // Candles koin + timeframe terpilih: 1h pakai candle 1h yang sudah diambil;
  // 4h = agregasi 4 x candle 1h (14400 tidak valid di Coinbase); 1d = fetch langsung.
  let selCandles = null
  if (tf === '1h') {
    selCandles = bySym[selCoin]?.candles1h || null
  } else if (tf === '4h') {
    const full = bySym[selCoin]?.candles1hFull
    selCandles = full ? aggregateCandles(full.slice(-96), 4) : null
  } else {
    selCandles = candleRes.status === 'fulfilled' ? candleRes.value : null
  }
  if (selCandles) selCandles = selCandles.slice(-24)

  const updatedAt = new Date().toISOString().slice(11, 16) + ' UTC'
  const webhookOn = state.webhook?.active === true
  const headerStatus = `Updated ${updatedAt} · Source: Coinbase · Webhook: ${webhookOn ? 'online' : 'offline (polling)'}${state.lastTick ? ` · Last tick ${state.lastTick.slice(11, 19)} UTC` : ''}`

  // Fear & Greed
  const fngHtml = fng
    ? (() => {
      const color = fng.value < 25 ? '#dc2626' : fng.value < 45 ? '#ea580c' : fng.value < 55 ? '#ca8a04' : fng.value < 75 ? '#65a30d' : '#16a34a'
      return `<div class="fng"><div class="fng-val" style="color:${color}">${fng.value}</div><div class="fng-label" style="color:${color}">${esc(fng.label)}</div><div class="fng-bar"><div class="fng-fill" style="left:${fng.value}%;background:${color}"></div></div><div class="fng-scale"><span>Extreme Fear</span><span>Extreme Greed</span></div></div>`
    })()
    : '<p class="muted">Fear &amp; Greed unavailable right now.</p>'

  // Live prices 5 koin
  const priceHtml = coins.length
    ? coins.map((c) => {
      const ch = typeof c.changePct === 'number'
        ? `<span class="${c.changePct >= 0 ? 'up' : 'down'}">${c.changePct >= 0 ? '+' : ''}${c.changePct.toFixed(1)}% 24h</span>`
        : '<span class="muted">—</span>'
      const hl = c.high24 !== null && c.low24 !== null
        ? `<div class="hl">24h high ${fmtPrice(c.high24)} · low ${fmtPrice(c.low24)}</div>`
        : ''
      const spark = c.closes.length >= 2 ? sparklineSvg(c.closes) : ''
      const price = c.price !== null ? fmtPrice(c.price) + (c.stale ? ' <span class="muted">(last known)</span>' : '') : '<span class="muted">unavailable</span>'
      return `<div class="price"><div><span class="sym">${c.sym}</span><div class="pval">${price}</div>${hl}</div><div class="pright">${spark}${ch}</div></div>`
    }).join('')
    : '<p class="muted">Prices unavailable right now.</p>'

  // Top movers (24h) — dari 5 koin yang dipantau, urut perubahan terbesar
  const movers = coins
    .filter((c) => typeof c.changePct === 'number')
    .sort((a, b) => b.changePct - a.changePct)
  const moversHtml = movers.length
    ? `<ol class="movers">${movers.map((c, i) => `<li><span>${i + 1}. ${c.sym}</span><b class="${c.changePct >= 0 ? 'up' : 'down'}">${c.changePct >= 0 ? '+' : ''}${c.changePct.toFixed(1)}%</b></li>`).join('')}</ol>`
    : '<p class="muted">Movers unavailable right now.</p>'

  // Candles: tab koin + timeframe (link query param, tanpa JS)
  const coinTabs = PRICE_SYMBOLS.map((s) =>
    `<a class="tab${s === selCoin ? ' active' : ''}" href="/app?coin=${s}&amp;tf=${tf}">${s}</a>`).join('')
  const tfTabs = Object.keys(TF_GRANULARITY).map((t) =>
    `<a class="tab${t === tf ? ' active' : ''}" href="/app?coin=${selCoin}&amp;tf=${t}">${t}</a>`).join('')
  let candleHtml = ''
  if (selCandles && selCandles.length >= 2) {
    const last = selCandles[selCandles.length - 1]
    const lo24 = Math.min(...selCandles.map((c) => c.low))
    const hi24 = Math.max(...selCandles.map((c) => c.high))
    const tfLabel = tf === '1h' ? '1h · last 24h' : tf === '4h' ? '4h · last 4 days' : '1d · last 24 days'
    candleHtml = `<div class="chart">${candlesSvg(selCandles)}</div>` +
      `<p class="ohlc">Last ${tf} candle: O ${fmtPrice(last.open)} · H ${fmtPrice(last.high)} · L ${fmtPrice(last.low)} · C ${fmtPrice(last.close)}<br>Range: ${fmtPrice(lo24)} – ${fmtPrice(hi24)} (${tfLabel})</p>`
  } else {
    candleHtml = '<p class="muted">Candles unavailable right now.</p>'
  }

  // Top 5 odds + countdown
  const topOdds = topOddsMarkets(gammaArr, 5)
  const oddsHtml = topOdds.length
    ? `<ul>${topOdds.map((m) => `<li><b>${esc(m.question)}</b><br><span class="odds-line">YES ${m.yes}% · vol ${fmtVolume(m.vol)}${m.countdown ? ` · ${esc(m.countdown)}` : ''}</span>${m.url ? `<br><a href="${esc(m.url)}">View on Polymarket ↗</a>` : ''}</li>`).join('')}</ul>`
    : '<p class="muted">Odds unavailable right now.</p>'

  // Active alerts kaya (tanpa chatId) — jarak ke ambang + status
  const allAlerts = [
    ...(state.alerts || []).map((a, i) => ({ a, i, kind: 'price' })),
    ...(state.oddsAlerts || []).map((a, i) => ({ a, i, kind: 'odds' })),
  ]
  const alertsHtml = allAlerts.length === 0
    ? '<p class="muted">No active alerts. Set one from the bot: /alert btc below 60000</p>'
    : `<ul>${allAlerts.map(({ a, kind }, n) => `<li>${esc(formatAlertLine(a, kind, n + 1, state.lastPrices, state.lastOdds))}</li>`).join('')}</ul>`

  const refreshUrl = `/app?coin=${selCoin}&amp;tf=${tf}`
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="60;url=${refreshUrl}"><title>PolyGlance</title><style>
body{margin:0;background:#ffffff;color:#111827;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px}
.wrap{max-width:640px;margin:0 auto}
h1{color:#059669;margin:0;font-size:26px}h2{color:#059669;font-size:13px;margin:20px 0 8px;text-transform:uppercase;letter-spacing:1px}
.sub{color:#6b7280;margin:2px 0 0}.status{color:#6b7280;font-size:12px;margin:8px 0 0}
.card{border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin:12px 0;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.price{display:flex;justify-content:space-between;align-items:center;border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;margin:6px 0}
.sym{font-weight:700;font-size:15px}.pval{font-size:19px;font-weight:700;margin-top:2px}.hl{font-size:11px;color:#6b7280;margin-top:2px}
.pright{text-align:right}.pright svg{display:block;margin:0 0 4px auto}
.up{color:#16a34a}.down{color:#dc2626}.muted{color:#9ca3af}
.fng{text-align:center}.fng-val{font-size:40px;font-weight:800}.fng-label{font-size:15px;font-weight:700}
.fng-bar{position:relative;height:8px;border-radius:4px;background:linear-gradient(90deg,#dc2626,#f59e0b,#facc15,#65a30d,#16a34a);margin:12px 4px 4px}
.fng-fill{position:absolute;top:-4px;width:4px;height:16px;border-radius:2px;transform:translateX(-2px)}
.fng-scale{display:flex;justify-content:space-between;font-size:11px;color:#6b7280}
.movers{margin:0;padding-left:22px}.movers li{display:flex;justify-content:space-between;margin:5px 0}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.tab{border:1px solid #d1d5db;border-radius:999px;padding:5px 12px;font-size:13px;color:#374151;text-decoration:none}
.tab.active{background:#059669;border-color:#059669;color:#fff;font-weight:700}
.chart{border:1px solid #e5e7eb;border-radius:10px;padding:8px 4px 2px}
.ohlc{font-size:12px;color:#4b5563;line-height:1.5}
.odds-line{font-size:13px;color:#4b5563}
ul{margin:0;padding-left:20px}li{margin:8px 0}
a{color:#059669}.links a{display:inline-block;margin:6px 14px 0 0}
.meta{color:#9ca3af;font-size:12px;margin-top:18px}
.appbar,.bottomnav{display:none}
html.native-mode body{background:#0f172a;color:#e2e8f0;padding:0 0 78px}
html.native-mode .wrap{padding:0 16px 8px}
html.native-mode h1,html.native-mode .sub{display:none}
html.native-mode .status{color:#94a3b8}
html.native-mode .card{background:#1e293b;border-color:#334155;box-shadow:0 2px 8px rgba(0,0,0,.4)}
html.native-mode h2{color:#34d399}
html.native-mode a{color:#34d399}
html.native-mode .price{background:#0f172a;border-color:#334155}
html.native-mode .sym,html.native-mode .pval{color:#f1f5f9}
html.native-mode .hl{color:#94a3b8}
html.native-mode .tab{border-color:#475569;color:#cbd5e1}
html.native-mode .tab.active{background:#059669;border-color:#059669;color:#fff}
html.native-mode .chart{border-color:#334155;background:#0f172a}
html.native-mode .ohlc{color:#94a3b8}
html.native-mode .odds-line{color:#94a3b8}
html.native-mode .muted{color:#64748b}
html.native-mode .meta{color:#64748b}
html.native-mode .appbar{display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:20;background:#0f172a;border-bottom:1px solid #1e293b;padding:12px 16px}
html.native-mode .appbar-logo{width:38px;height:38px;border-radius:11px;background:#000;display:flex;align-items:center;justify-content:center;flex:none}
html.native-mode .appbar-text{display:flex;flex-direction:column}
html.native-mode .appbar-title{font-size:18px;font-weight:800;color:#f8fafc;line-height:1.15}
html.native-mode .appbar-sub{font-size:11px;color:#94a3b8}
html.native-mode .bottomnav{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:20;background:#1e293b;border-top:1px solid #334155;padding:6px 4px calc(6px + env(safe-area-inset-bottom))}
html.native-mode .bottomnav a{flex:1;text-align:center;text-decoration:none;color:#94a3b8;font-size:11px;font-weight:600;padding:4px 0 2px}
html.native-mode .bottomnav a svg{display:block;margin:0 auto 2px}
html.native-mode .bottomnav a:focus{color:#34d399}
html.native-mode .bottomnav a.active{color:#34d399}
html.native-mode #sec-prices,html.native-mode #sec-odds,html.native-mode #sec-alerts,html.native-mode #sec-more{scroll-margin-top:70px}
html.native-mode .appbar-logo img{width:38px;height:38px;border-radius:11px;display:block}
</style><script>try{if(!(window.Telegram&&window.Telegram.WebApp)){document.documentElement.className+=' native-mode';}}catch(e){}</script></head><body><header class="appbar"><span class="appbar-logo"><img src="data:image/png;base64,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" width="38" height="38" alt="PolyGlance"></span><span class="appbar-text"><span class="appbar-title">PolyGlance</span><span class="appbar-sub">Even Realities G2 · Android</span></span></header><div class="wrap">
<h1>PolyGlance</h1><p class="sub">Crypto at a glance — Even Realities G2</p>
<p class="status">${esc(headerStatus)}</p>
<div class="card"><h2 style="margin-top:0">Fear &amp; Greed Index</h2>${fngHtml}</div>
<div class="card" id="sec-prices"><h2 style="margin-top:0">Live prices</h2>${priceHtml}</div>
<div class="card"><h2 style="margin-top:0">Top movers · 24h</h2>${moversHtml}</div>
<div class="card"><h2 style="margin-top:0">Candles · ${selCoin} · ${tf}</h2><div class="tabs">${coinTabs}</div><div class="tabs">${tfTabs}</div>${candleHtml}</div>
<div class="card" id="sec-odds"><h2 style="margin-top:0">Top Polymarket odds</h2>${oddsHtml}</div>
<div class="card" id="sec-alerts"><h2 style="margin-top:0">Active alerts (${allAlerts.length})</h2>${alertsHtml}</div>
<div id="sec-more"><h2>Links</h2><div class="links"><a href="${BUILD_URL}">DoraHacks Build 51900</a><a href="${VIDEO_URL}">Demo video</a><a href="https://t.me/polyglance_alerts_bot">Telegram bot</a></div></div>
<p class="meta">Read-only dashboard · Refreshes every 60s · Set or remove alerts from the bot, not here.</p>
</div><nav class="bottomnav"><a href="#sec-prices"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 20v-5M12 20V7M18 20v-8M3 20h18"/></svg>Prices</a><a href="#sec-odds"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-7 7"/></svg>Odds</a><a href="#sec-alerts"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>Alerts</a><a href="#sec-more"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>More</a></nav><script>(function(){try{
var nav=document.querySelector('.bottomnav');if(!nav)return;
var links=Array.prototype.slice.call(nav.querySelectorAll('a'));
function setActive(a){links.forEach(function(l){l.classList.toggle('active',l===a)})}
links.forEach(function(a){a.addEventListener('click',function(e){
e.preventDefault();
var t=document.querySelector(a.getAttribute('href'));
if(t){t.scrollIntoView({behavior:'smooth',block:'start'})}
lastClick=Date.now();
setActive(a);
})});
if(links[0])links[0].classList.add('active');
var ticking=false,lastClick=0;
function onScroll(){
if(Date.now()-lastClick<900)return;
if(ticking)return;ticking=true;
requestAnimationFrame(function(){ticking=false;
var best=null,bestTop=-Infinity;
links.forEach(function(a){
var t=document.querySelector(a.getAttribute('href'));if(!t)return;
var top=t.getBoundingClientRect().top;
if(top<=90&&top>bestTop){best=a;bestTop=top}
});
if(!best)best=links[0];
setActive(best);
})}
window.addEventListener('scroll',onScroll,{passive:true});
}catch(e){}})();</script></body></html>`
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

/** Pasang profil bot + menu button (GET /setupbot, sekali-pakai). Pakai secret token Worker sendiri. */
async function handleSetupBot(env) {
  const token = env.POLYGLANCE_BOT_TOKEN
  if (!token) return Response.json({ ok: false, error: 'no token' }, { status: 500 })
  const call = async (method, body) => {
    const res = await fetch(`${tg(token)}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.json().catch(() => ({}))
  }
  const set = {}
  set.shortDescription = await call('setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION })
  set.description = await call('setMyDescription', { description: BOT_DESCRIPTION })
  set.commands = await call('setMyCommands', { commands: BOT_COMMANDS })
  set.menuButton = await call('setChatMenuButton', { menu_button: MENU_BUTTON })
  // Verifikasi: baca kembali dari Telegram.
  const get = async (method) => {
    const res = await fetch(`${tg(token)}/${method}`)
    return res.json().catch(() => ({}))
  }
  const verify = {}
  verify.shortDescription = await get('getMyShortDescription')
  verify.description = await get('getMyDescription')
  verify.commands = await get('getMyCommands')
  verify.menuButton = await get('getChatMenuButton')
  return Response.json({ ok: true, set, verify })
}

/** Baca profil + menu button live dari Telegram (GET /botinfo, diagnostik). */
async function handleBotInfo(env) {
  const token = env.POLYGLANCE_BOT_TOKEN
  if (!token) return Response.json({ ok: false, error: 'no token' }, { status: 500 })
  const get = async (method) => {
    const res = await fetch(`${tg(token)}/${method}`)
    return res.json().catch(() => ({}))
  }
  return Response.json({
    ok: true,
    shortDescription: await get('getMyShortDescription'),
    description: await get('getMyDescription'),
    commands: await get('getMyCommands'),
    menuButton: await get('getChatMenuButton'),
  })
}


function emptyMeta() {
  return { offset: 0, chats: [], processedUpdateIds: [] }
}
function emptyPrices() {
  return { lastPrices: null, lastTick: null, priceSource: null, priceError: null, lastOdds: null }
}
function emptyAlerts() {
  return { alerts: [], oddsAlerts: [] }
}
function emptyLive() {
  return { messages: [] }
}

async function loadPart(kv, key, empty) {
  try {
    const raw = await kv.get(key)
    if (!raw) return empty()
    const s = JSON.parse(raw)
    return { ...empty(), ...s }
  } catch {
    return empty()
  }
}

/** Baca semua bagian paralel, gabung jadi satu objek `state` (dipakai handler lama).
 * opts.skipWebhook (v8.2, hemat KV): lewati baca KEY_WEBHOOK — tick cron
 * memakai flag dari cache in-memory (getWebhookFlagCached) supaya tidak
 * ada 1 baca KV/menit (= 1.440 reads/hari) untuk flag yang berubah 1x/jam.
 * Migrasi webhook legacy juga dilewati dalam mode ini (sudah selesai
 * sejak v1 — tidak ada lagi blob legacy yang perlu dimigrasi). */
async function loadAll(kv, opts = {}) {
  const [meta, prices, alerts, live] = await Promise.all([
    loadPart(kv, KEY_META, emptyMeta),
    loadPart(kv, KEY_PRICES, emptyPrices),
    loadPart(kv, KEY_ALERTS, emptyAlerts),
    loadPart(kv, KEY_LIVE, emptyLive),
  ])
  const webhook = opts.skipWebhook
    ? webhookFlagCache
    : await loadPart(kv, KEY_WEBHOOK, () => null)
  // Migrasi sekali (v1 -> key terpisah): kalau key baru masih kosong tapi
  // blob lama (KEY_META) masih menyimpan field itu, pakai nilai lama + tulis
  // ke key baru. `meta` sendiri membawa field legacy itu (spread di loadPart
  // mempertahankan key yang tidak dikenal emptyMeta).
  const legacy = meta
  const migrated = {}
  if (legacy && typeof legacy === 'object') {
    if (!prices.lastTick && !prices.lastPrices && (legacy.lastPrices || legacy.lastTick || legacy.lastOdds)) {
      Object.assign(prices, { lastPrices: legacy.lastPrices ?? null, lastTick: legacy.lastTick ?? null, priceSource: legacy.priceSource ?? null, priceError: legacy.priceError ?? null, lastOdds: legacy.lastOdds ?? null })
      migrated.prices = true
    }
    if (alerts.alerts.length === 0 && (legacy.alerts || []).length > 0) {
      alerts.alerts = legacy.alerts
      migrated.alerts = true
    }
    if ((alerts.oddsAlerts || []).length === 0 && (legacy.oddsAlerts || []).length > 0) {
      alerts.oddsAlerts = legacy.oddsAlerts
      migrated.alerts = true
    }
    if (!opts.skipWebhook && !webhook && legacy.webhook) {
      migrated.webhook = legacy.webhook
    }
  }
  const state = { ...meta, ...prices, ...alerts, webhook: webhook ?? migrated.webhook ?? null, live }
  // Tulis hasil migrasi (best-effort; gagal pun tidak fatal — fallback baca tetap jalan).
  try {
    if (migrated.prices) await kv.put(KEY_PRICES, JSON.stringify(prices))
    if (migrated.alerts) await kv.put(KEY_ALERTS, JSON.stringify(alerts))
    if (migrated.webhook) await kv.put(KEY_WEBHOOK, JSON.stringify(migrated.webhook))
  } catch { /* abaikan */ }
  return state
}

// --- Hemat KV (v8.2) ---
// Akun Cloudflare ilham kena limit KV harian 26 Nov (50% 16:27 WIB, 90%
// 22:44 WIB; reset 00:00 UTC). Meter yang kehabisan hampir pasti WRITES
// (batas gratis 1.000/hari): tick menulis key prices 1x/menit hanya karena
// lastTick berubah = 1.440 writes/hari. Perbaikan ada 3:
//  (a) throttle penulisan key prices ke 10 menit (di tick, sebelum saveChanged),
//  (b) flag webhook di-cache in-memory (di bawah) — tick tidak lagi baca
//      KEY_WEBHOOK tiap menit (hemat 1.440 reads/hari),
//  (c) dashboard /app + /health pakai cache in-memory 90 detik dengan
//      fallback snapshot basi saat KV 429/gagal (di bawah).
// Fitur baru v8.2 (/ask, /whales, /fng, Morning Brief) TIDAK pakai KV,
// kecuali guard sekali-per-hari Morning Brief (1 baca di jam 01:00 UTC +
// 1 tulis/hari — lihat tick §1d).

/** Cache in-memory flag webhook: dimuat sekali per isolate, disegarkan oleh
  verifikasi berkala di tick (§2) + /setwebhook. Restart isolate = muat ulang
  sekali (verifikasi berkala jalan di tick pertama karena checkedAt kosong). */
let webhookFlagCache = null
let webhookFlagLoaded = false

async function getWebhookFlagCached(kv) {
  if (webhookFlagLoaded) return webhookFlagCache
  try {
    const raw = await kv.get(KEY_WEBHOOK)
    webhookFlagCache = raw ? JSON.parse(raw) : null
  } catch {
    webhookFlagCache = null
  }
  webhookFlagLoaded = true
  return webhookFlagCache
}

/** Cache in-memory snapshot dashboard (90 detik) untuk GET /app + /health.
  Pemakaian read-only — pemanggil TIDAK BOLEH mengubah state yang
  dikembalikan. Saat KV gagal (429/limit), sajikan snapshot basi daripada
  halaman error (data dashboard berumur <=90 detik di kondisi normal). */
let dashCache = { at: 0, state: null }
const DASH_CACHE_MS = 90 * 1000

async function loadAllCached(kv) {
  const now = Date.now()
  if (dashCache.state && now - dashCache.at < DASH_CACHE_MS) return dashCache.state
  try {
    const state = await loadAll(kv)
    dashCache = { at: now, state }
    return state
  } catch (e) {
    if (dashCache.state) return dashCache.state
    throw e
  }
}

/** Snapshot JSON tiap bagian — untuk menyimpan hanya bagian yang berubah. */
function snapshotParts(state) {
  return {
    meta: JSON.stringify({ offset: state.offset, chats: state.chats, processedUpdateIds: state.processedUpdateIds || [] }),
    prices: JSON.stringify({ lastPrices: state.lastPrices, lastTick: state.lastTick, priceSource: state.priceSource, priceError: state.priceError, lastOdds: state.lastOdds }),
    alerts: JSON.stringify({ alerts: state.alerts, oddsAlerts: state.oddsAlerts || [] }),
    live: JSON.stringify({ messages: state.live?.messages || [] }),
  }
}

function partOf(state, which) {
  if (which === 'meta') return { offset: state.offset, chats: state.chats, processedUpdateIds: state.processedUpdateIds || [] }
  if (which === 'prices') return { lastPrices: state.lastPrices, lastTick: state.lastTick, priceSource: state.priceSource, priceError: state.priceError, lastOdds: state.lastOdds }
  if (which === 'live') return { messages: state.live?.messages || [] }
  return { alerts: state.alerts, oddsAlerts: state.oddsAlerts || [] }
}

/** Simpan HANYA bagian yang berubah vs snapshot (hindari timpa-menimpa antar penulis). */
async function saveChanged(kv, state, snap) {
  const jobs = []
  for (const [which, key] of [['meta', KEY_META], ['prices', KEY_PRICES], ['alerts', KEY_ALERTS], ['live', KEY_LIVE]]) {
    if (JSON.stringify(partOf(state, which)) !== snap[which]) {
      jobs.push(kv.put(key, JSON.stringify(partOf(state, which))))
    }
  }
  await Promise.all(jobs)
}

async function saveWebhookFlag(kv, flag) {
  await kv.put(KEY_WEBHOOK, JSON.stringify(flag))
}

/** Kirim pesan bot. Return message_id (number) kalau terkirim, null kalau gagal.
 * Dipakai /price untuk melacak pesan live-nya (di-edit tiap tick). */
async function sendMessage(token, chatId, text) {
  try {
    const res = await fetch(`${tg(token)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    return typeof data?.result?.message_id === 'number' ? data.result.message_id : null
  } catch {
    return null
  }
}

/**
 * Edit pesan bot sendiri (untuk live /price). Return:
 *  'ok' — berhasil; 'not_modified' — teks sama (harga belum bergerak, bukan error);
 *  'not_found' — pesan sudah dihapus / tidak bisa di-edit (berhenti lacak);
 *  'error' — gagal lain (coba lagi tick berikutnya, entri dipertahankan).
 */
async function editMessageText(token, chatId, messageId, text) {
  try {
    const res = await fetch(`${tg(token)}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok && data?.ok) return 'ok'
    const desc = String(data?.description || '')
    if (/message is not modified/i.test(desc)) return 'not_modified'
    if (/message to edit not found|message can't be edited|message to delete not found/i.test(desc)) return 'not_found'
    return 'error'
  } catch {
    return 'error'
  }
}

async function handleCommand(token, state, chatId, parsed, env) {
  const now = new Date().toISOString()
  switch (parsed.cmd) {
    case 'start': {
      if (!state.chats.includes(chatId)) state.chats.push(chatId)
      await sendMessage(
        token,
        chatId,
        'Hi! I am @polyglance_alerts_bot, the PolyGlance alert bot.\n' +
          'Set a price alert and I will ping you when it hits — even when the glasses app is closed.\n\n' +
          HELP_TEXT,
      )
      return
    }
    case 'help':
      await sendMessage(token, chatId, HELP_TEXT)
      return
    case 'health': {
      const yourPrice = state.alerts.filter((a) => a.chatId === chatId).length
      const yourOdds = (state.oddsAlerts || []).filter((a) => a.chatId === chatId).length
      await sendMessage(
        token,
        chatId,
        formatHealthReply({
          lastTick: state.lastTick,
          lastPrices: state.lastPrices,
          priceSource: state.priceSource,
          yourPrice,
          yourOdds,
          chats: state.chats.length,
          webhookActive: state.webhook?.active === true,
        }),
      )
      return
    }
    case 'price': {
      const coins = await fetchLivePrices(state)
      const updated = new Date().toISOString().slice(11, 16) + ' UTC'
      // Pesan live: dilacak di KV (satu per chat) lalu di-edit tiap tick cron
      // selama 30 menit dengan harga fresh — footer di teks menjelaskan itu.
      const messageId = await sendMessage(token, chatId, formatPriceReply(coins, 'Coinbase', updated, { live: true }))
      if (typeof messageId === 'number') {
        state.live = { messages: trackLivePrice(state.live?.messages, chatId, messageId) }
      }
      return
    }
    case 'odds': {
      try {
        const res = await fetch(GAMMA_URL)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const arr = Array.isArray(data) ? data : data?.markets ?? []
        const lines = formatOddsRich(arr, 5)
        await sendMessage(token, chatId, lines.length ? 'Top 5 Polymarket crypto odds:\n\n' + lines.join('\n\n') : 'No odds right now.')
      } catch {
        await sendMessage(token, chatId, 'Could not fetch odds right now.')
      }
      return
    }
    case 'ask': {
      // v8.2: tanya pasar — dijawab AI 2 baris dari data live (atau penolakan
      // prediksi/advice). env diteruskan dari handleUpdate (butuh GROQ_API_KEY).
      const out = await askGroq(parsed.question, env)
      if (out.error) {
        await sendMessage(token, chatId, 'ASK is unavailable right now — try again in a minute.')
      } else {
        await sendMessage(token, chatId, out.answer)
      }
      return
    }
    case 'whales': {
      // v8.2: trade paus Polymarket — format yang sama dengan GET /whales.
      try {
        const res = await fetchWithTimeout(WHALES_TRADES_URL, 8000)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const trades = parseWhaleTrades(Array.isArray(data) ? data : data?.trades ?? data?.data ?? [], Date.now())
        await sendMessage(token, chatId, formatWhalesReply(trades))
      } catch {
        await sendMessage(token, chatId, 'Could not fetch whale trades right now.')
      }
      return
    }
    case 'brief': {
      // v8.2: digest pagi ini, on-demand (tanpa menunggu jam 08:00 WIB).
      try {
        const text = await buildMorningBriefText(state)
        await sendMessage(token, chatId, text)
      } catch {
        await sendMessage(token, chatId, 'Could not build the morning brief right now.')
      }
      return
    }
    case 'alert': {
      const alert = {
        chatId,
        coin: parsed.coin,
        direction: parsed.direction,
        price: parsed.price,
        fired: false,
        createdAt: now,
      }
      state.alerts.push(alert)
      const cur = state.lastPrices?.[parsed.coin.toLowerCase()]
      await sendMessage(token, chatId, formatAlertSetReply(alert, cur))
      return
    }
    case 'alertodds': {
      // Cari pasar dari keyword di Gamma saat ini, lalu simpan alertnya.
      try {
        const res = await fetch(GAMMA_URL)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const arr = Array.isArray(data) ? data : data?.markets ?? []
        const found = findOddsMarket(arr, parsed.keyword)
        if (!found) {
          await sendMessage(token, chatId, `No Polymarket market matches "${parsed.keyword}". Try another keyword, e.g. /alertodds bitcoin above 60`)
          return
        }
        const alert = {
          chatId,
          keyword: parsed.keyword,
          question: found.question,
          threshold: parsed.pct,
          direction: parsed.direction,
          fired: false,
          lastYes: found.yes,
          createdAt: now,
        }
        ;(state.oddsAlerts || (state.oddsAlerts = [])).push(alert)
        await sendMessage(token, chatId, formatOddsAlertSetReply(alert, found.yes))
      } catch {
        await sendMessage(token, chatId, 'Could not fetch odds right now. Try again in a minute.')
      }
      return
    }
    case 'list': {
      await sendMessage(token, chatId, formatAlertsList(state.alerts, state.oddsAlerts, chatId, state.lastPrices, state.lastOdds))
      return
    }
    case 'remove': {
      const all = myAlerts(state.alerts, state.oddsAlerts, chatId)
      const target = all[parsed.index - 1]
      if (!target) {
        await sendMessage(
          token,
          chatId,
          `No alert #${parsed.index} — you only have ${all.length} alert${all.length === 1 ? '' : 's'}.\n\n` +
            formatAlertsList(state.alerts, state.oddsAlerts, chatId, state.lastPrices, state.lastOdds),
        )
        return
      }
      let removed
      if (target.kind === 'price') {
        removed = state.alerts[target.i]
        state.alerts.splice(target.i, 1)
      } else {
        removed = state.oddsAlerts[target.i]
        state.oddsAlerts.splice(target.i, 1)
      }
      const remaining = myAlerts(state.alerts, state.oddsAlerts, chatId).length
      await sendMessage(token, chatId, formatRemovedReply(removed, target.kind, remaining))
      return
    }
  }
}

async function handleUpdate(token, state, update, env) {
  const msg = update?.message
  if (!msg || typeof msg.text !== 'string') return
  // friendlyReply TIDAK PERNAH null: perintah valid -> jalan; perintah
  // telanjang / typo / teks asing -> balasan yang berguna (cara pakai /
  // ringkasan). pesan penolakan mentah sudah tidak dipakai lagi.
  const routed = friendlyReply(msg.text)
  if (routed.parsed) {
    await handleCommand(token, state, msg.chat.id, routed.parsed, env)
  } else {
    await sendMessage(token, msg.chat.id, routed.usage)
  }
}

/** Satu tick cron: harga -> alert crossing -> perintah bot. */
async function tick(env) {
  const token = env.POLYGLANCE_BOT_TOKEN
  if (!token) throw new Error('POLYGLANCE_BOT_TOKEN secret not set')
  const kv = env.ALERTS_KV
  // Hemat KV (v8.2): lewati baca KEY_WEBHOOK tiap menit — flag diambil dari
  // cache in-memory (getWebhookFlagCached), disegarkan verifikasi berkala §2.
  const state = await loadAll(kv, { skipWebhook: true })
  state.webhook = await getWebhookFlagCached(kv)
  const snap = snapshotParts(state)

  // 1. Harga terbaru — CoinGecko dulu, Coinbase sebagai cadangan.
  // CoinGecko dari Worker bisa kena rate-limit (harga null ber-tick-tick);
  // Binance tidak bisa dipakai (451 restricted location dari AS).
  let prices = null
  let priceSource = null
  let priceError = null
  try {
    const res = await fetch(COINGECKO_URL)
    if (res.ok) prices = parseCoinGeckoPrices(await res.json())
    else priceError = `coingecko ${res.status}`
    if (prices) priceSource = 'coingecko'
  } catch (e) {
    priceError = `coingecko ${e?.message || 'fetch gagal'}`
  }
  if (!prices) {
    try {
      const [rb, re] = await Promise.all([fetch(COINBASE_BTC_URL), fetch(COINBASE_ETH_URL)])
      const btc = rb.ok ? parseCoinbaseSpot(await rb.json()) : null
      const eth = re.ok ? parseCoinbaseSpot(await re.json()) : null
      if (typeof btc === 'number' && typeof eth === 'number') {
        prices = { btc, eth }
        priceSource = 'coinbase'
      } else {
        priceError = (priceError ? priceError + '; ' : '') + `coinbase ${rb.status}/${re.status}`
      }
    } catch (e) {
      priceError = (priceError ? priceError + '; ' : '') + `coinbase ${e?.message || 'fetch gagal'}`
    }
  }
  state.priceSource = priceSource
  state.priceError = priceError
  if (prices) {
    const { fired, alerts } = checkAlertCrossings(state.alerts, state.lastPrices, prices)
    state.alerts = alerts
    for (const f of fired) {
      await sendMessage(
        token,
        f.alert.chatId,
        `${f.alert.coin} HIT ${fmtUsd(f.alert.price)}! Now ${fmtUsd(f.price)}. Set in PolyGlance.`,
      )
    }
    state.lastPrices = prices
  }

  // 1b. Odds alerts — hanya kalau ada yang diset (hemat satu fetch Gamma).
  // Ambil YES% terbaru dari Gamma, cek crossing terhadap tick sebelumnya.
  if ((state.oddsAlerts || []).length > 0) {
    try {
      const res = await fetch(GAMMA_URL)
      if (res.ok) {
        const data = await res.json()
        const arr = Array.isArray(data) ? data : data?.markets ?? []
        const newOdds = oddsYesByQuestion(arr)
        const { fired, alerts } = checkOddsAlertCrossings(state.oddsAlerts, state.lastOdds, newOdds)
        // lastYes per alert TIDAK ditulis tiap tick: "now %" di /list dibaca
        // dari state.lastOdds (key harga). Key alert hanya berubah kalau ada
        // crossing (fired flip) — mengurangi timpa-menimpa dengan webhook.
        state.oddsAlerts = alerts
        for (const f of fired) {
          const short = f.alert.question.replace(/^Will\s+/i, '')
          const shortQ = short.length > 40 ? short.slice(0, 37) + '...' : short
          await sendMessage(
            token,
            f.alert.chatId,
            `ODDS ALERT: "${shortQ}" YES ${f.yes}% — crossed ${f.alert.direction} ${f.alert.threshold}%!`,
          )
        }
        state.lastOdds = newOdds
      }
    } catch {
      // Gamma gagal — coba lagi tick berikutnya, alert tidak hilang
    }
  }

  // 1c. Live /price — edit pesan /price yang masih <30 menit dengan harga
  // fresh (1 fetch untuk semua chat). Entri kedaluwarsa dibuang; entri yang
  // pesannya sudah dihapus (edit -> not_found) juga dibuang; gagal lain
  // (network) dipertahankan untuk dicoba lagi tick berikutnya. Scope HANYA
  // /price — /odds dan perintah lain tidak disentuh.
  {
    const { live, expired } = pruneLivePrices(state.live?.messages)
    if (expired.length > 0 || live.length !== (state.live?.messages || []).length) {
      state.live = { messages: live }
    }
    if (live.length > 0) {
      const coins = await fetchLivePrices(state)
      if (coins.length > 0) {
        const updated = new Date().toISOString().slice(11, 16) + ' UTC'
        const text = formatPriceReply(coins, 'Coinbase', updated, { live: true })
        const remaining = []
        for (const m of live) {
          const result = await editMessageText(token, m.chatId, m.messageId, text)
          if (result === 'not_found') continue // pesan dihapus -> berhenti lacak
          remaining.push(m)
        }
        if (remaining.length !== live.length) state.live = { messages: remaining }
      }
    }
  }

  // 1d. Morning Brief (v8.2) — digest Telegram 08:00 WIB (01:00 UTC),
  // sekali per hari, ke semua chat yang pernah /start.
  // TANPA KV kecuali perlu: guard lastSentDate dibaca HANYA di jam 01:00 UTC
  // (briefDue), dan cache in-memory menahan baca ulang dalam jam yang sama
  // (maks ~1 baca KV/hari + 1 tulis/hari). Kalau brief gagal (fetch/API),
  // tick lanjut normal — dicoba lagi tick berikutnya selama masih jam 01:00.
  {
    const nowMs = Date.now()
    if (new Date(nowMs).getUTCHours() === 1 && state.chats.length > 0) {
      const today = new Date(nowMs).toISOString().slice(0, 10)
      let lastSent = briefCache.date === today ? briefCache.sentDate : null
      if (briefCache.date !== today) {
        try {
          const raw = await kv.get(KEY_BRIEF)
          lastSent = raw ? JSON.parse(raw)?.lastSentDate ?? null : null
        } catch { lastSent = null }
        briefCache = { date: today, sentDate: lastSent }
      }
      if (briefDue(lastSent, nowMs)) {
        try {
          const text = await buildMorningBriefText(state)
          let sent = 0
          for (const chatId of state.chats) {
            const id = await sendMessage(token, chatId, text)
            if (id !== null) sent++
          }
          if (sent > 0) {
            await kv.put(KEY_BRIEF, JSON.stringify({ lastSentDate: today }))
            briefCache.sentDate = today
          }
        } catch {
          // Brief gagal — coba lagi tick berikutnya (masih jam 01:00 UTC)
        }
      }
    }
  }

  // 2. Perintah bot.
  // Webhook aktif -> SKIP polling getUpdates (Telegram mengirim update ke
  // /webhook; getUpdates akan kosong). Cron tetap jalan untuk harga + alert.
  // Verifikasi berkala (~1 jam, dua arah): baca status webhook LIVE dari
  // Telegram dan sinkronkan flag — kalau webhook dihapus dari luar, kembali
  // ke polling; kalau flag sempat hilang tapi webhook masih terpasang,
  // flag dipulihkan. Flag tinggal di key sendiri (KEY_WEBHOOK) supaya tick
  // tidak pernah menimpa tulisan /setwebhook dengan snapshot lama.
  const wh = state.webhook
  const lastChecked = wh?.checkedAt ? Date.parse(wh.checkedAt) : 0
  if (Date.now() - lastChecked > 3600_000) {
    try {
      const infoRes = await fetch(`${tg(token)}/getWebhookInfo`)
      if (infoRes.ok) {
        const info = await infoRes.json()
        const url = info?.result?.url || ''
        const flag = {
          active: url === WEBHOOK_URL,
          url,
          setAt: wh?.setAt || new Date().toISOString(),
          checkedAt: new Date().toISOString(),
          pending: info?.result?.pending_update_count ?? 0,
        }
        await saveWebhookFlag(kv, flag)
        webhookFlagCache = flag // segarkan cache in-memory (hemat baca KV)
        webhookFlagLoaded = true
        state.webhook = flag
      }
    } catch {
      // getWebhookInfo gagal — pertahankan flag, coba lagi tick berikutnya
    }
  }
  if (!state.webhook?.active) {
    try {
      const res = await fetch(`${tg(token)}/getUpdates?offset=${state.offset || 0}&timeout=0&limit=50`)
      if (res.ok) {
        const data = await res.json()
        for (const u of data.result || []) {
          state.offset = u.update_id + 1
          await handleUpdate(token, state, u, env)
        }
      }
    } catch {
      // Telegram gagal — coba lagi tick berikutnya
    }
  }

  state.lastTick = new Date().toISOString()
  // HEMAT KV (v8.2): tahan penulisan key prices — lastTick berubah tiap
  // menit, jadi tanpa throttle key ini ditulis 1.440x/hari (melewati batas
  // gratis 1.000 writes/hari — penyebab alert limit 26 Nov). Sekarang key
  // prices ditulis paling cepat 10 menit sekali (shouldPersistPrices).
  // Deteksi crossing alert TETAP aman: cek tiap tick memakai harga segar vs
  // harga tersimpan terakhir (jendela deteksi melebar, bukan menyempit);
  // /health + /app menampilkan lastTick yang tertinggal <=10 menit (jujur).
  // Simpan HANYA bagian yang berubah: meta hanya kalau polling (offset),
  // alert hanya kalau ada crossing.
  const snapPrices = JSON.parse(snap.prices)
  if (!shouldPersistPrices(snapPrices.lastTick)) {
    state.lastTick = snapPrices.lastTick
    state.lastPrices = snapPrices.lastPrices
    state.lastOdds = snapPrices.lastOdds
    state.priceSource = snapPrices.priceSource
    state.priceError = snapPrices.priceError
  }
  await saveChanged(kv, state, snap)
  return state
}

// --- STT fallback proxy (POST /stt) ---
// Kenapa ada: fetch langsung ke api.groq.com dari WebView kacamata bisa HANG
// (Cloudflare menahan client WebKitGTK simulator — terbukti 26 Nov ~02:00 WIB),
// sementara CoinGecko + Gamma dari WebView yang sama lancar, dan curl dari
// mesin yang sama dapat 401 dalam 0,27 detik. Fase 1 fetch yang sama sempat
// lolos, jadi kondisinya berubah-ubah. Worker ini jadi perantara: aplikasi
// kirim WAV ke sini, Worker teruskan ke Groq pakai key dari secret
// GROQ_API_KEY (pakai key Groq KEDUA/testing milik ilham — JANGAN key utama).
// Key tidak pernah lewat HP/kacamata.
// Body: multipart/form-data, field 'file' (alias 'audio') = file WAV.
// Balasan: JSON { text } — sama seperti Groq. Tanpa secret -> 500.
const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const GROQ_STT_MODEL = 'whisper-large-v3-turbo'
const MAX_AUDIO_BYTES = 25 * 1024 * 1024 // batas Groq 25 MB

const sttCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

async function handleStt(request, env) {
  if (!env.GROQ_API_KEY) {
    return Response.json({ error: 'GROQ_API_KEY secret not set' }, { status: 500, headers: sttCorsHeaders })
  }
  let form
  try {
    form = await request.formData()
  } catch {
    return Response.json({ error: 'expected multipart/form-data with audio file' }, { status: 400, headers: sttCorsHeaders })
  }
  const file = form.get('file') ?? form.get('audio')
  if (!file || typeof file === 'string' || file.size === 0) {
    return Response.json({ error: 'no audio file (field "file")' }, { status: 400, headers: sttCorsHeaders })
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return Response.json({ error: 'audio too large (max 25 MB)' }, { status: 413, headers: sttCorsHeaders })
  }
  const forward = new FormData()
  forward.append('file', file, file.name || 'voice.wav')
  forward.append('model', GROQ_STT_MODEL)
  forward.append('language', 'en')
  forward.append('response_format', 'json')
  let res
  try {
    res = await fetch(GROQ_STT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: forward,
      signal: AbortSignal.timeout(20000),
    })
  } catch {
    return Response.json({ error: 'groq unreachable' }, { status: 502, headers: sttCorsHeaders })
  }
  if (!res.ok) {
    return Response.json({ error: `groq ${res.status}` }, { status: res.status, headers: sttCorsHeaders })
  }
  try {
    const data = await res.json()
    return Response.json({ text: typeof data.text === 'string' ? data.text.trim() : '' }, { headers: sttCorsHeaders })
  } catch {
    return Response.json({ error: 'bad groq response' }, { status: 502, headers: sttCorsHeaders })
  }
}

// --- v8.2: ASK / WHALES / F&G / Morning Brief ---
// Semua handler di bawah TANPA KV (cache in-memory saja), kecuali guard
// sekali-per-hari Morning Brief di tick() (§1d). Groq chat memakai secret
// GROQ_API_KEY yang SAMA dengan proxy STT (key Groq KEDUA/testing milik
// ilham — JANGAN key utama). Key tidak pernah lewat HP/kacamata.

/** Konteks live untuk ASK: harga BTC/ETH/SOL + odds Polymarket + Fear &
  Greed + funding Hyperliquid — semua Promise.allSettled, sumber yang gagal
  dilewati diam-diam (barisnya hilang, jawaban menyebut data yang ada). */
async function askLiveContext() {
  const lines = []
  const jobs = [
    (async () => {
      try {
        const coins = await fetchLivePrices(null)
        for (const c of coins) {
          if (c.sym === 'BTC' || c.sym === 'ETH' || c.sym === 'SOL') {
            lines.push(`${c.sym} ${fmtPrice(c.price)}${typeof c.changePct === 'number' ? ` (${c.changePct >= 0 ? '+' : ''}${c.changePct.toFixed(1)}% 24h)` : ''}`)
          }
        }
      } catch { /* baris ini hilang */ }
    })(),
    (async () => {
      try {
        const res = await fetchWithTimeout(GAMMA_URL, 5000)
        if (res.ok) {
          const data = await res.json()
          const arr = Array.isArray(data) ? data : data?.markets ?? []
          for (const m of topOddsMarkets(arr, 3)) lines.push(`Polymarket: "${m.question}" YES ${m.yes}%`)
        }
      } catch { /* abaikan */ }
    })(),
    (async () => {
      try {
        const res = await fetchWithTimeout(FNG_URL, 5000)
        if (res.ok) {
          const fng = parseFearGreed(await res.json())
          if (fng) lines.push(`Fear & Greed: ${fng.value} (${fng.label})`)
        }
      } catch { /* abaikan */ }
    })(),
    (async () => {
      // Funding rata-rata Hyperliquid (parse inline — hl.ts milik kacamata,
      // bukan Worker): metaAndAssetCtxs -> [meta, assetCtxs].
      try {
        const res = await fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
          signal: AbortSignal.timeout(5000),
        })
        if (res.ok) {
          const data = await res.json()
          const ctxs = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : null
          if (ctxs) {
            const funds = ctxs.slice(0, 3).map((c) => parseFloat(String(c?.funding ?? ''))).filter(Number.isFinite)
            if (funds.length) {
              lines.push(`Hyperliquid funding avg: ${(funds.reduce((a, b) => a + b, 0) / funds.length * 100).toFixed(4)}%/h`)
            }
          }
        }
      } catch { /* abaikan */ }
    })(),
  ]
  await Promise.allSettled(jobs)
  return lines
}

/**
 * Satu pertanyaan ASK -> Groq chat (qwen/qwen3.8-27b — llama-3.3-70b-versatile ditarik Groq, 404; gpt-oss-20b flaky/kosong).
 * Return {answer} | {answer: ASK_REFUSAL, refused:true} | {error}.
 * Pre-check penolakan dulu (tanpa Groq — hemat kuota + deterministik);
 * batas in-memory 60 pertanyaan/menit per isolate (anti-spam publik).
 */
async function askGroq(question, env) {
  if (isAskRefusalNeeded(question)) return { answer: ASK_REFUSAL, refused: true }
  if (!env.GROQ_API_KEY) return { error: 'GROQ_API_KEY secret not set' }
  const now = Date.now()
  if (now - askMinuteStart >= 60000) { askMinuteStart = now; askMinuteCount = 0 }
  if (askMinuteCount >= 60) return { error: 'ask rate limit — try again in a minute' }
  askMinuteCount++
  const dataLines = await askLiveContext()
  let res
  try {
    res = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_CHAT_MODEL,
        messages: buildAskMessages(question, dataLines),
        temperature: 0.3,
        max_tokens: 120,
      }),
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    })
  } catch {
    return { error: 'groq unreachable' }
  }
  if (!res.ok) return { error: `groq ${res.status}` }
  let data
  try { data = await res.json() } catch { return { error: 'bad groq response' } }
  const answer = parseAskAnswer(data?.choices?.[0]?.message?.content)
  if (!answer) return { error: 'empty groq answer' }
  return { answer }
}

/**
 * Satu pertanyaan ASK-WEB -> Groq chat (model yang sama, qwen/qwen3.8-27b).
 * Return {answer} | {answer: ASK_REFUSAL, refused:true} | {error}.
 * Cerminan askGroq, bedanya: prompt umum + jawaban sampai 6 baris
 * (parseAskWebAnswer), batas pertanyaan 3..500 karakter (dicek di
 * handleAskWeb), dan rate cap TERPISAH (60/menit per isolate) supaya
 * trafik website tidak memakan kuota /ask kacamata — dan sebaliknya.
 */
async function askWebGroq(question, env) {
  if (isAskRefusalNeeded(question)) return { answer: ASK_REFUSAL, refused: true }
  if (!env.GROQ_API_KEY) return { error: 'GROQ_API_KEY secret not set' }
  const now = Date.now()
  if (now - askWebMinuteStart >= 60000) { askWebMinuteStart = now; askWebMinuteCount = 0 }
  if (askWebMinuteCount >= ASK_WEB_RATE_LIMIT_PER_MIN) return { error: 'ask-web rate limit — try again in a minute' }
  askWebMinuteCount++
  const dataLines = await askLiveContext()
  let res
  try {
    res = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_CHAT_MODEL,
        messages: buildAskWebMessages(question, dataLines),
        temperature: 0.3,
        max_tokens: 400,
      }),
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    })
  } catch {
    return { error: 'groq unreachable' }
  }
  if (!res.ok) return { error: `groq ${res.status}` }
  let data
  try { data = await res.json() } catch { return { error: 'bad groq response' } }
  const answer = parseAskWebAnswer(data?.choices?.[0]?.message?.content)
  if (!answer) return { error: 'empty groq answer' }
  return { answer }
}

const askCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

/** POST /ask {question} -> {answer} | {answer: penolakan, refused:true}.
  Dipakai kacamata (view ASK) + siapa pun yang POST ke endpoint ini. */
async function handleAsk(request, env) {
  let body
  try { body = await request.json() } catch {
    return Response.json({ error: 'expected JSON {question}' }, { status: 400, headers: askCorsHeaders })
  }
  const question = typeof body?.question === 'string' ? body.question.trim() : ''
  if (question.length < 3 || question.length > 200) {
    return Response.json({ error: 'question must be 3..200 characters' }, { status: 400, headers: askCorsHeaders })
  }
  const out = await askGroq(question, env)
  if (out.error) return Response.json({ error: out.error }, { status: 502, headers: askCorsHeaders })
  return Response.json({ answer: out.answer, refused: !!out.refused }, { headers: askCorsHeaders })
}

const askWebCorsHeaders = ASK_WEB_CORS_HEADERS

/** POST /ask-web {question} -> {answer} | {answer: penolakan, refused:true}.
  Otak umum website (bukan kacamata): pertanyaan umum dijawab dari
  pengetahuan produk + crypto umum + data live; prediksi/advice ditolak
  (isAskRefusalNeeded, sebelum Groq). Batas pertanyaan 3..500 karakter.
  Groq gagal -> 502 {error} (widget yang menangani fallback, seperti /ask). */
async function handleAskWeb(request, env) {
  let body
  try { body = await request.json() } catch {
    return Response.json({ error: 'expected JSON {question}' }, { status: 400, headers: askWebCorsHeaders })
  }
  const question = typeof body?.question === 'string' ? body.question.trim() : ''
  if (!isValidAskWebQuestion(question)) {
    return Response.json({ error: 'question must be 3..500 characters' }, { status: 400, headers: askWebCorsHeaders })
  }
  const out = await askWebGroq(question, env)
  if (out.error) return Response.json({ error: out.error }, { status: 502, headers: askWebCorsHeaders })
  return Response.json({ answer: out.answer, refused: !!out.refused }, { headers: askWebCorsHeaders })
}

const whalesCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

/** GET /whales -> {trades, updatedAt, count}. Proxy data-api v2 /trades
  (CORS v2 belum teruji dari WebView kacamata — jangan fetch langsung dari
  kacamata). Cache in-memory 45 detik; kalau fetch gagal, sajikan cache basi
  (kacamata menampilkan "OFFLINE - last data"). */
async function handleWhales() {
  const now = Date.now()
  if (whalesCache && now - whalesCacheAt < WHALES_CACHE_MS) {
    return Response.json(whalesCache, { headers: whalesCorsHeaders })
  }
  try {
    const res = await fetchWithTimeout(WHALES_TRADES_URL, 8000)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const trades = parseWhaleTrades(Array.isArray(data) ? data : data?.trades ?? data?.data ?? [], now)
    const payload = { trades, updatedAt: new Date(now).toISOString(), count: trades.length }
    whalesCache = payload
    whalesCacheAt = now
    return Response.json(payload, { headers: whalesCorsHeaders })
  } catch (e) {
    if (whalesCache) return Response.json(whalesCache, { headers: whalesCorsHeaders })
    return Response.json({ error: `whales unavailable (${e?.message || 'fetch gagal'})`, trades: [] }, { status: 502, headers: whalesCorsHeaders })
  }
}

const fngCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

/** GET /fng -> {value, label, updatedAt}. Proxy Alternative.me (domain ini
  TIDAK ada di whitelist app.json — kacamata WAJIB lewat proxy ini).
  Cache in-memory 5 menit; kalau fetch gagal, sajikan cache basi. */
async function handleFng() {
  const now = Date.now()
  if (fngCache && now - fngCacheAt < FNG_CACHE_MS) {
    return Response.json(fngCache, { headers: fngCorsHeaders })
  }
  try {
    const res = await fetchWithTimeout(FNG_URL, 5000)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const fng = parseFearGreed(await res.json())
    if (!fng) throw new Error('bad payload')
    const payload = { value: fng.value, label: fng.label, updatedAt: new Date(now).toISOString() }
    fngCache = payload
    fngCacheAt = now
    return Response.json(payload, { headers: fngCorsHeaders })
  } catch (e) {
    if (fngCache) return Response.json(fngCache, { headers: fngCorsHeaders })
    return Response.json({ error: `fng unavailable (${e?.message || 'fetch gagal'})` }, { status: 502, headers: fngCorsHeaders })
  }
}

const newsCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

/** GET /news -> {headlines, source, updatedAt}. Proxy RSS CoinDesk
  (fallback Cointelegraph). Cache in-memory 10 menit; kalau fetch gagal,
  sajikan cache basi. TIDAK PERNAH mengarang headline — feed kosong/rusak
  dan tanpa cache -> 502 {headlines: []}. */
async function handleNews() {
  const now = Date.now()
  if (newsCache && now - newsCacheAt < NEWS_CACHE_MS) {
    return Response.json(newsCache, { headers: newsCorsHeaders })
  }
  for (const feedUrl of NEWS_FEED_URLS) {
    try {
      const res = await fetchWithTimeout(feedUrl, 8000)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const headlines = parseNewsHeadlines(await res.text())
      if (headlines.length === 0) throw new Error('no headlines')
      const payload = { headlines, source: new URL(feedUrl).hostname, updatedAt: new Date(now).toISOString() }
      newsCache = payload
      newsCacheAt = now
      return Response.json(payload, { headers: newsCorsHeaders })
    } catch (e) {
      console.log('news feed failed:', feedUrl, e?.message || e)
    }
  }
  if (newsCache) return Response.json(newsCache, { headers: newsCorsHeaders })
  return Response.json({ error: 'news unavailable', headlines: [] }, { status: 502, headers: newsCorsHeaders })
}

/** Teks Morning Brief: harga 5 koin + Fear & Greed + 3 odds teratas.
  Dipakai tick §1d (kirim 08:00 WIB) dan /brief on-demand. */
async function buildMorningBriefText(state) {
  const [coins, fng, topOdds] = await Promise.all([
    fetchLivePrices(state).catch(() => []),
    (async () => {
      try {
        const res = await fetchWithTimeout(FNG_URL, 5000)
        return res.ok ? parseFearGreed(await res.json()) : null
      } catch { return null }
    })(),
    (async () => {
      try {
        const res = await fetchWithTimeout(GAMMA_URL, 5000)
        if (!res.ok) return []
        const data = await res.json()
        const arr = Array.isArray(data) ? data : data?.markets ?? []
        return topOddsMarkets(arr, 3)
      } catch { return [] }
    })(),
  ])
  // Tanggal WIB (UTC+7) untuk header digest.
  const dateLabel = new Date(Date.now() + 7 * 3600 * 1000).toUTCString().slice(0, 16)
  return formatMorningBrief({ coins, fng, topOdds, dateLabel })
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env))
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      try {
        const state = await loadAllCached(env.ALERTS_KV) // cache 90 detik + fallback basi (hemat KV)
        return Response.json({
          ok: true,
          lastTick: state.lastTick,
          alerts: state.alerts.length,
          oddsAlerts: (state.oddsAlerts || []).length,
          chats: state.chats.length,
          btc: state.lastPrices?.btc ?? null,
          eth: state.lastPrices?.eth ?? null,
          priceSource: state.priceSource ?? null,
          priceError: state.priceError ?? null,
          webhook: state.webhook
            ? { active: !!state.webhook.active, url: state.webhook.url || null, pending: state.webhook.pending ?? null, setAt: state.webhook.setAt || null }
            : { active: false, url: null },
        })
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 500 })
      }
    }
    if (request.method === 'GET' && url.pathname === '/setwebhook') {
      // Sekali-pakai (dipakai sekali saat migrasi polling -> webhook).
      // HANYA memasang URL tetap WEBHOOK_URL — tidak terima URL dari parameter,
      // jadi worst case route ini cuma me-reset webhook ke URL yang benar.
      // Route ini sengaja dibiarkan aktif karena tidak bisa disalahgunakan
      // untuk mengarahkan update ke server lain.
      try {
        const token = env.POLYGLANCE_BOT_TOKEN
        if (!token) return Response.json({ ok: false, error: 'no token' }, { status: 500 })
        const setRes = await fetch(`${tg(token)}/setWebhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: WEBHOOK_URL, drop_pending_updates: false }),
        })
        const setData = await setRes.json().catch(() => ({}))
        const infoRes = await fetch(`${tg(token)}/getWebhookInfo`)
        const info = await infoRes.json().catch(() => ({}))
        const whUrl = info?.result?.url || ''
        // Flag tinggal di key sendiri (KEY_WEBHOOK) — TIDAK menyentuh blob
        // state utama, supaya tick tidak bisa menimpanya dengan snapshot lama.
        const flag = {
          active: whUrl === WEBHOOK_URL,
          url: whUrl,
          setAt: new Date().toISOString(),
          checkedAt: new Date().toISOString(),
          pending: info?.result?.pending_update_count ?? 0,
        }
        await saveWebhookFlag(env.ALERTS_KV, flag)
        return Response.json({ ok: true, setWebhook: setData, webhookInfo: info?.result ?? null, stored: flag })
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 500 })
      }
    }
    if (request.method === 'GET' && url.pathname === '/webhookinfo') {
      // Diagnostik: status webhook live dari Telegram (bukan dari KV).
      try {
        const token = env.POLYGLANCE_BOT_TOKEN
        if (!token) return Response.json({ ok: false, error: 'no token' }, { status: 500 })
        const infoRes = await fetch(`${tg(token)}/getWebhookInfo`)
        const info = await infoRes.json().catch(() => ({}))
        return Response.json({ ok: infoRes.ok, webhookInfo: info?.result ?? null })
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 500 })
      }
    }
    if (request.method === 'GET' && url.pathname === '/app') {
      // Dashboard read-only (dibuka dari menu button Telegram / browser).
      try {
        return await handleApp(env, url)
      } catch (e) {
        return new Response('PolyGlance — dashboard unavailable right now.', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      }
    }
    if (request.method === 'GET' && url.pathname === '/setupbot') {
      // Sekali-pakai: pasang profil bot + menu button (lihat handleSetupBot).
      try {
        return await handleSetupBot(env)
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 500 })
      }
    }
    if (request.method === 'GET' && url.pathname === '/botinfo') {
      // Diagnostik: profil + menu button live dari Telegram.
      try {
        return await handleBotInfo(env)
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 500 })
      }
    }
    if (request.method === 'POST' && url.pathname === '/webhook') {
      // Mode webhook: Telegram POST update ke sini begitu pesan masuk.
      // Jawab 200 CEPAT supaya Telegram tidak retry; proses di background
      // via ctx.waitUntil. Dedupe update_id (ring buffer 50) untuk
      // antisipasi kalau Telegram mengirim update yang sama dua kali.
      // Logika perintahnya SAMA seperti jalur polling (handleUpdate).
      try {
        const token = env.POLYGLANCE_BOT_TOKEN
        if (!token) return Response.json({ ok: false, error: 'no token' }, { status: 500 })
        const update = await request.json()
        ctx.waitUntil(
          (async () => {
            try {
              const state = await loadAll(env.ALERTS_KV)
              const snap = snapshotParts(state)
              const uid = update?.update_id
              const seen = state.processedUpdateIds || []
              if (typeof uid === 'number' && seen.includes(uid)) return
              if (typeof uid === 'number') {
                state.processedUpdateIds = [...seen, uid].slice(-50)
              }
              await handleUpdate(token, state, update, env)
              // Simpan hanya bagian yang berubah (meta selalu — processedUpdateIds;
              // alert hanya kalau ada /alert, /alertodds, /remove).
              await saveChanged(env.ALERTS_KV, state, snap)
            } catch (e) {
              console.error('webhook process failed', e)
            }
          })(),
        )
        return Response.json({ ok: true })
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 500 })
      }
    }
    if (request.method === 'OPTIONS' && url.pathname === '/stt') {
      return new Response(null, { status: 204, headers: sttCorsHeaders })
    }
    if (request.method === 'POST' && url.pathname === '/stt') {
      return handleStt(request, env)
    }
    if (request.method === 'OPTIONS' && url.pathname === '/ask') {
      return new Response(null, { status: 204, headers: askCorsHeaders })
    }
    if (request.method === 'POST' && url.pathname === '/ask') {
      // v8.2 ASK: tanya pasar -> jawaban AI 2 baris dari data live.
      return handleAsk(request, env)
    }
    if (request.method === 'OPTIONS' && url.pathname === '/ask-web') {
      return new Response(null, { status: 204, headers: askWebCorsHeaders })
    }
    if (request.method === 'POST' && url.pathname === '/ask-web') {
      // v8.3 ASK-WEB: otak umum website -> jawaban AI sampai 6 baris
      // (produk + crypto umum + data live). /ask kacamata tidak berubah.
      return handleAskWeb(request, env)
    }
    if (request.method === 'OPTIONS' && url.pathname === '/whales') {
      return new Response(null, { status: 204, headers: whalesCorsHeaders })
    }
    if (request.method === 'GET' && url.pathname === '/whales') {
      // v8.2 WHALES: trade Polymarket >=$1.000 (proxy data-api v2 /trades).
      return handleWhales()
    }
    if (request.method === 'OPTIONS' && url.pathname === '/fng') {
      return new Response(null, { status: 204, headers: fngCorsHeaders })
    }
    if (request.method === 'GET' && url.pathname === '/fng') {
      // v8.2 MOOD: Fear & Greed Index (proxy Alternative.me).
      return handleFng()
    }
    if (request.method === 'OPTIONS' && url.pathname === '/news') {
      return new Response(null, { status: 204, headers: newsCorsHeaders })
    }
    if (request.method === 'GET' && url.pathname === '/news') {
      // v8.4 NEWS: headline crypto (proxy RSS CoinDesk, fallback Cointelegraph).
      return handleNews()
    }
    return Response.json({
      ok: true,
      service: 'polyglance-watcher',
      usage: 'GET /health — status (incl. webhook); GET /app — dashboard read-only; GET /setwebhook — pasang webhook Telegram ke /webhook (URL tetap); GET /webhookinfo — status webhook live; GET /setupbot — pasang profil bot + menu button (sekali-pakai); GET /botinfo — profil + menu button live; POST /webhook — Telegram webhook; POST /stt — STT fallback proxy (multipart file=WAV, needs GROQ_API_KEY secret); POST /ask — ask the market (JSON {question}, needs GROQ_API_KEY secret); POST /ask-web — ask the website assistant (JSON {question}, needs GROQ_API_KEY secret); GET /whales — big Polymarket crypto trades ($1,000+); GET /fng — Fear & Greed Index; GET /news — crypto headlines (CoinDesk RSS, Cointelegraph fallback)',
    })
  },
}
