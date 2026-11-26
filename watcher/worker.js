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
  parseCoinGeckoPrices,
  parseCoinbaseSpot,
  parseCoinbaseStats,
  parseCoinbaseCandles,
  aggregateCandles,
  parseFearGreed,
  candlesSvg,
  sparklineSvg,
  HELP_TEXT,
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
  'Use /price, /odds, /alert, /alertodds, /list, /remove, /health or /help.',
  '',
  'Build: dorahacks.io/build/51900',
].join('\n')
const BOT_COMMANDS = [
  { command: 'start', description: 'Start PolyGlance alerts' },
  { command: 'price', description: 'Live prices: BTC, ETH, SOL, DOGE & XRP' },
  { command: 'odds', description: 'Top 5 Polymarket crypto odds' },
  { command: 'alert', description: 'Set a price alert, e.g. /alert btc above 58000' },
  { command: 'alertodds', description: 'Set an odds alert, e.g. /alertodds btc dip above 60' },
  { command: 'list', description: 'List your alerts' },
  { command: 'remove', description: 'Remove an alert, e.g. /remove 1' },
  { command: 'health', description: 'Check if the watcher is alive' },
  { command: 'help', description: 'Show the full guide' },
]
const MENU_BUTTON = { type: 'web_app', text: 'Open PolyGlance', web_app: { url: 'https://polyglance-watcher.danham322.workers.dev/app' } }
const BUILD_URL = 'https://dorahacks.io/build/51900'
const VIDEO_URL = 'https://www.youtube.com/watch?v=7jwChwKZxKQ'

const tg = (token) => `https://api.telegram.org/bot${token}`

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** fetch dengan timeout (AbortSignal.timeout tersedia di Worker + Node 18+). */
async function fetchWithTimeout(url, ms = 5000) {
  return fetch(url, { signal: AbortSignal.timeout(ms) })
}

/** Harga live 5 koin untuk /price: spot Coinbase + stats (perubahan 24 jam).
 * Per koin gagal -> fallback harga terakhir dari cron (BTC/ETH, ditandai stale)
 * -> kalau tidak ada juga, koin dilewati. */
async function fetchLivePrices(state) {
  const jobs = PRICE_SYMBOLS.map(async (sym) => {
    let price = null
    let changePct = null
    try {
      const res = await fetchWithTimeout(COINBASE_SPOT(sym), 8000)
      if (res.ok) price = parseCoinbaseSpot(await res.json())
    } catch { /* lanjut ke stats / fallback */ }
    try {
      const res = await fetchWithTimeout(COINBASE_STATS(sym), 8000)
      if (res.ok) {
        const st = parseCoinbaseStats(await res.json())
        if (st) {
          changePct = st.changePct
          if (price === null) price = st.last
        }
      }
    } catch { /* lanjut ke fallback */ }
    if (price === null && state?.lastPrices) {
      const known = state.lastPrices[sym.toLowerCase()]
      if (typeof known === 'number') return { sym, price: known, changePct, stale: true }
    }
    if (price === null) return null
    return { sym, price, changePct, stale: false }
  })
  return (await Promise.all(jobs)).filter(Boolean)
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

/** Dashboard read-only (GET /app) — TEMA PUTIH, mobile-first, tanpa JS, tanpa secret.
 * Bagian: header status, Fear & Greed, live prices 5 koin + sparkline,
 * top movers, candles (5 koin + timeframe via ?coin=&tf=), top 5 odds +
 * countdown, active alerts kaya, links (TANPA link repo). Kalau satu sumber
 * gagal, bagiannya tampil "unavailable" kecil — halaman lain tetap jalan. */
async function handleApp(env, url) {
  const state = await loadAll(env.ALERTS_KV)
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
    ? `<ul>${topOdds.map((m) => `<li><b>${esc(m.question)}</b><br><span class="odds-line">YES ${m.yes}% · vol ${fmtVolume(m.vol)}${m.countdown ? ` · ${esc(m.countdown)}` : ''}</span>${m.slug ? `<br><a href="https://polymarket.com/event/${esc(m.slug)}">polymarket.com/event/${esc(m.slug)}</a>` : ''}</li>`).join('')}</ul>`
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
</style></head><body><div class="wrap">
<h1>PolyGlance</h1><p class="sub">Crypto at a glance — Even Realities G2</p>
<p class="status">${esc(headerStatus)}</p>
<div class="card"><h2 style="margin-top:0">Fear &amp; Greed Index</h2>${fngHtml}</div>
<div class="card"><h2 style="margin-top:0">Live prices</h2>${priceHtml}</div>
<div class="card"><h2 style="margin-top:0">Top movers · 24h</h2>${moversHtml}</div>
<div class="card"><h2 style="margin-top:0">Candles · ${selCoin} · ${tf}</h2><div class="tabs">${coinTabs}</div><div class="tabs">${tfTabs}</div>${candleHtml}</div>
<div class="card"><h2 style="margin-top:0">Top Polymarket odds</h2>${oddsHtml}</div>
<div class="card"><h2 style="margin-top:0">Active alerts (${allAlerts.length})</h2>${alertsHtml}</div>
<h2>Links</h2><div class="links"><a href="${BUILD_URL}">DoraHacks Build 51900</a><a href="${VIDEO_URL}">Demo video</a><a href="https://t.me/polyglance_alerts_bot">Telegram bot</a></div>
<p class="meta">Read-only dashboard · Refreshes every 60s · Set or remove alerts from the bot, not here.</p>
</div></body></html>`
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

/** Baca semua bagian paralel, gabung jadi satu objek `state` (dipakai handler lama). */
async function loadAll(kv) {
  const [meta, prices, alerts, webhook] = await Promise.all([
    loadPart(kv, KEY_META, emptyMeta),
    loadPart(kv, KEY_PRICES, emptyPrices),
    loadPart(kv, KEY_ALERTS, emptyAlerts),
    loadPart(kv, KEY_WEBHOOK, () => null),
  ])
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
    if (!webhook && legacy.webhook) {
      migrated.webhook = legacy.webhook
    }
  }
  const state = { ...meta, ...prices, ...alerts, webhook: webhook ?? migrated.webhook ?? null }
  // Tulis hasil migrasi (best-effort; gagal pun tidak fatal — fallback baca tetap jalan).
  try {
    if (migrated.prices) await kv.put(KEY_PRICES, JSON.stringify(prices))
    if (migrated.alerts) await kv.put(KEY_ALERTS, JSON.stringify(alerts))
    if (migrated.webhook) await kv.put(KEY_WEBHOOK, JSON.stringify(migrated.webhook))
  } catch { /* abaikan */ }
  return state
}

/** Snapshot JSON tiap bagian — untuk menyimpan hanya bagian yang berubah. */
function snapshotParts(state) {
  return {
    meta: JSON.stringify({ offset: state.offset, chats: state.chats, processedUpdateIds: state.processedUpdateIds || [] }),
    prices: JSON.stringify({ lastPrices: state.lastPrices, lastTick: state.lastTick, priceSource: state.priceSource, priceError: state.priceError, lastOdds: state.lastOdds }),
    alerts: JSON.stringify({ alerts: state.alerts, oddsAlerts: state.oddsAlerts || [] }),
  }
}

function partOf(state, which) {
  if (which === 'meta') return { offset: state.offset, chats: state.chats, processedUpdateIds: state.processedUpdateIds || [] }
  if (which === 'prices') return { lastPrices: state.lastPrices, lastTick: state.lastTick, priceSource: state.priceSource, priceError: state.priceError, lastOdds: state.lastOdds }
  return { alerts: state.alerts, oddsAlerts: state.oddsAlerts || [] }
}

/** Simpan HANYA bagian yang berubah vs snapshot (hindari timpa-menimpa antar penulis). */
async function saveChanged(kv, state, snap) {
  const jobs = []
  for (const [which, key] of [['meta', KEY_META], ['prices', KEY_PRICES], ['alerts', KEY_ALERTS]]) {
    if (JSON.stringify(partOf(state, which)) !== snap[which]) {
      jobs.push(kv.put(key, JSON.stringify(partOf(state, which))))
    }
  }
  await Promise.all(jobs)
}

async function saveWebhookFlag(kv, flag) {
  await kv.put(KEY_WEBHOOK, JSON.stringify(flag))
}

async function sendMessage(token, chatId, text) {
  try {
    const res = await fetch(`${tg(token)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function handleCommand(token, state, chatId, parsed) {
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
      await sendMessage(token, chatId, formatPriceReply(coins, 'Coinbase', updated))
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

async function handleUpdate(token, state, update) {
  const msg = update?.message
  if (!msg || typeof msg.text !== 'string') return
  // friendlyReply TIDAK PERNAH null: perintah valid -> jalan; perintah
  // telanjang / typo / teks asing -> balasan yang berguna (cara pakai /
  // ringkasan). pesan penolakan mentah sudah tidak dipakai lagi.
  const routed = friendlyReply(msg.text)
  if (routed.parsed) {
    await handleCommand(token, state, msg.chat.id, routed.parsed)
  } else {
    await sendMessage(token, msg.chat.id, routed.usage)
  }
}

/** Satu tick cron: harga -> alert crossing -> perintah bot. */
async function tick(env) {
  const token = env.POLYGLANCE_BOT_TOKEN
  if (!token) throw new Error('POLYGLANCE_BOT_TOKEN secret not set')
  const kv = env.ALERTS_KV
  const state = await loadAll(kv)
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
          await handleUpdate(token, state, u)
        }
      }
    } catch {
      // Telegram gagal — coba lagi tick berikutnya
    }
  }

  state.lastTick = new Date().toISOString()
  // Simpan HANYA bagian yang berubah: harga selalu (lastTick), meta hanya
  // kalau polling (offset), alert hanya kalau ada crossing.
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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env))
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      try {
        const state = await loadAll(env.ALERTS_KV)
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
              await handleUpdate(token, state, update)
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
    return Response.json({
      ok: true,
      service: 'polyglance-watcher',
      usage: 'GET /health — status (incl. webhook); GET /app — dashboard read-only; GET /setwebhook — pasang webhook Telegram ke /webhook (URL tetap); GET /webhookinfo — status webhook live; GET /setupbot — pasang profil bot + menu button (sekali-pakai); GET /botinfo — profil + menu button live; POST /webhook — Telegram webhook; POST /stt — STT fallback proxy (multipart file=WAV, needs GROQ_API_KEY secret)',
    })
  },
}
