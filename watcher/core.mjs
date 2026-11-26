// PolyGlance watcher — logika bersama (murni, tanpa API Node/Worker).
// Dipakai oleh worker.js (Cloudflare Worker, target utama) dan watcher.js
// (Node di Termux, fallback demo). Satu sumber kebenaran untuk perintah bot
// + deteksi crossing alert.

export function fmtUsd(n) {
  return '$' + Math.round(n).toLocaleString('en-US')
}

export function parseCoinGeckoPrices(data) {
  const btc = data?.bitcoin?.usd
  const eth = data?.ethereum?.usd
  if (typeof btc !== 'number' || typeof eth !== 'number') return null
  return { btc, eth }
}

/** Parse satu harga spot Coinbase (api.coinbase.com/v2/prices/<COIN>-USD/spot). */
export function parseCoinbaseSpot(data) {
  const amount = parseFloat(String(data?.data?.amount ?? ''))
  if (!Number.isFinite(amount) || amount <= 0) return null
  return amount
}

/** Jarak edit Levenshtein (kecil, cukup untuk typo arah). */
function levenshtein(a, b) {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/**
 * Cocokkan kata arah — terima alias + typo umum (about->above, bellow->below,
 * abov->above). Ambang jarak <= 2: 'about' vs 'above' = 2, 'bellow' vs
 * 'below' = 1. Return 'above' | 'below' | null.
 */
export function matchDirection(word) {
  if (!word || typeof word !== 'string') return null
  const w = word.toLowerCase()
  if (w === 'above' || w === 'over' || w === '>') return 'above'
  if (w === 'below' || w === 'under' || w === '<') return 'below'
  if (/[^a-z]/.test(w)) return null
  const dAbove = levenshtein(w, 'above')
  const dBelow = levenshtein(w, 'below')
  if (dAbove <= 2 && dAbove <= dBelow) return 'above'
  if (dBelow <= 2 && dBelow < dAbove) return 'below'
  return null
}

/** Parse teks perintah Telegram. Return null kalau tidak dikenal. */
export function parseBotCommand(text) {
  if (!text || typeof text !== 'string') return null
  const parts = text.trim().split(/\s+/)
  const cmd = parts[0].toLowerCase()
  if (cmd === '/start') return { cmd: 'start' }
  if (cmd === '/help') return { cmd: 'help' }
  if (cmd === '/price') return { cmd: 'price' }
  if (cmd === '/odds') return { cmd: 'odds' }
  if (cmd === '/list') return { cmd: 'list' }
  if (cmd === '/health') return { cmd: 'health' }
  if (cmd === '/remove') {
    const n = parseInt(parts[1], 10)
    if (Number.isFinite(n) && n >= 1) return { cmd: 'remove', index: n }
    return null
  }
  if (cmd === '/alert') {
    // /alert btc above 58000 | /alert eth below 1900 (arah boleh typo: about, bellow, ...)
    const coinRaw = (parts[1] || '').toLowerCase()
    const coin = coinRaw === 'btc' || coinRaw === 'bitcoin' ? 'BTC'
      : coinRaw === 'eth' || coinRaw === 'ethereum' ? 'ETH' : null
    const direction = matchDirection(parts[2] || '')
    const price = parseFloat(String(parts[3] || '').replace(/[$,]/g, ''))
    if (!coin || !direction || !Number.isFinite(price) || price <= 0) return null
    return { cmd: 'alert', coin, direction, price }
  }
  if (cmd === '/alertodds') {
    // /alertodds <keyword...> above|below <pct> — mis. /alertodds btc dip above 60
    // /alertodds bitcoin below 40. Keyword = semua kata sebelum arah.
    // Arah boleh typo (about/bellow/...) — dicari dengan matchDirection.
    const di = parts.findIndex((p, i) => i >= 1 && matchDirection(p) !== null)
    if (di < 2) return null
    const direction = matchDirection(parts[di])
    const pct = parseFloat(String(parts[di + 1] || '').replace(/[%]/g, ''))
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null
    const keyword = parts.slice(1, di).join(' ').trim()
    if (!keyword) return null
    return { cmd: 'alertodds', keyword, direction, pct }
  }
  if (cmd === '/ask') {
    // /ask <pertanyaan bebas> — dijawab AI 2 baris dari data live.
    // Prediksi / financial advice ditolak di handler (isAskRefusalNeeded).
    const question = parts.slice(1).join(' ').trim()
    if (question.length < 3) return null
    return { cmd: 'ask', question: question.slice(0, 200) }
  }
  if (cmd === '/whales') return { cmd: 'whales' }
  if (cmd === '/brief') return { cmd: 'brief' }
  return null
}

/** Usage guide tiap perintah yang butuh argumen (dipakai fallback ramah).
 * English only — tiap teks diawali satu baris deskripsi: apa yang dilakukan
 * perintah itu. */
export const USAGE_TEXT = {
  alert: 'Price alerts — I\'ll ping you when a coin\'s price crosses your target. Usage: /alert <coin> above|below <price> — Example: /alert btc below 60000 — I\'ll ping you when BTC drops below $60,000. Coins: btc, eth.',
  alertodds: 'Odds alerts — I\'ll ping you when a Polymarket market\'s YES% crosses your threshold. Usage: /alertodds <keyword> above|below <pct> — Example: /alertodds btc dip above 60 — I\'ll ping you when the YES% of the "BTC dip" market rises above 60%.',
  remove: 'Remove one of your alerts — it stops watching that price or market. Usage: /remove <number> — Example: /remove 1 — removes alert #1. See your alerts first with /list.',
  ask: 'Ask the market — I answer from live prices, odds and Fear & Greed, in 2 lines. Usage: /ask <question> — Example: /ask why is bitcoin down? — I quote live numbers, never predict prices and never give financial advice.',
}

export const FALLBACK_TEXT = 'PolyGlance alerts — live prices, Polymarket odds, price & odds alerts for your Even G2 glasses. I didn\'t understand that — here\'s what I can do:\n/price — live BTC/ETH/SOL/DOGE/XRP prices\n/odds — top 5 Polymarket crypto odds\n/ask why is bitcoin down? — ask the market (2-line answer from live data)\n/whales — big Polymarket crypto trades ($1,000+)\n/brief — this morning\'s market digest\n/alert btc below 60000 — price alert\n/alertodds btc dip above 60 — odds alert\n/list — see your alerts\nType /help for the full guide.'

/**
 * Arahkan pesan masuk ke perintah atau balasan ramah — TIDAK PERNAH null.
 * Return { parsed } kalau perintah valid, atau { usage } berisi teks balasan
 * yang berguna (cara pakai perintah itu / ringkasan kemampuan bot).
 * Pesan penolakan mentah sudah tidak dipakai lagi di mana pun.
 */
export function friendlyReply(text) {
  const parsed = parseBotCommand(text)
  if (parsed) return { parsed }
  if (!text || typeof text !== 'string') return { usage: FALLBACK_TEXT }
  const parts = text.trim().split(/\s+/)
  const cmd = (parts[0] || '').toLowerCase()
  if (cmd === '/alert') {
    const dirWord = parts[2] || ''
    if (dirWord && /^[a-z]+$/i.test(dirWord) && matchDirection(dirWord) === null) {
      return { usage: `Direction "${dirWord}" isn't recognized — use above or below.\n${USAGE_TEXT.alert}` }
    }
    return { usage: USAGE_TEXT.alert }
  }
  if (cmd === '/alertodds') return { usage: USAGE_TEXT.alertodds }
  if (cmd === '/ask') return { usage: USAGE_TEXT.ask }
  if (cmd === '/remove') return { usage: USAGE_TEXT.remove }
  return { usage: FALLBACK_TEXT }
}

/**
 * Cek crossing alert terhadap harga baru.
 * alerts: [{chatId, coin, direction, price, fired}]
 * prevPrices / newPrices: {btc, eth} (harga coin per alert).
 * Sekali per crossing: setelah fire, fired=true sampai harga kembali ke sisi
 * lain (reset fired=false) — tidak spam saat harga goyang di garis.
 * Return { fired: [{alert, price}], alerts } (alerts = daftar ter-update).
 */
export function checkAlertCrossings(alerts, prevPrices, newPrices) {
  const fired = []
  const updated = (alerts || []).map((a) => {
    const prev = prevPrices?.[a.coin.toLowerCase()]
    const now = newPrices?.[a.coin.toLowerCase()]
    if (typeof prev !== 'number' || typeof now !== 'number') return a
    const target = a.price
    if (a.direction === 'above') {
      if (!a.fired && prev < target && now >= target) {
        fired.push({ alert: a, price: now })
        return { ...a, fired: true }
      }
      if (a.fired && now < target) return { ...a, fired: false }
    } else {
      if (!a.fired && prev > target && now <= target) {
        fired.push({ alert: a, price: now })
        return { ...a, fired: true }
      }
      if (a.fired && now > target) return { ...a, fired: false }
    }
    return a
  })
  return { fired, alerts: updated }
}

const CRYPTO_KEYWORD = /\b(bitcoin|btc|ethereum|eth|crypto|solana)\b/i

// Alias koin dua arah: pengguna mengetik "btc" tapi question bilang "Bitcoin" (dan sebaliknya).
const COIN_ALIASES = {
  btc: ['bitcoin'], bitcoin: ['btc'],
  eth: ['ethereum'], ethereum: ['eth'],
  sol: ['solana'], solana: ['sol'],
  doge: ['dogecoin'], dogecoin: ['doge'],
  xrp: ['ripple'], ripple: ['xrp'],
}

/** Cek satu kata keyword cocok di question (termasuk alias koin). */
function keywordWordMatches(questionLower, word) {
  if (questionLower.includes(word)) return true
  const aliases = COIN_ALIASES[word] || []
  return aliases.some((a) => questionLower.includes(a))
}

/**
 * Cari satu market Polymarket dari array mentah Gamma berdasarkan keyword.
 * Semua kata keyword harus muncul di question (case-insensitive, alias koin
 * dihitung cocok); kalau beberapa cocok, pilih volume24hr terbesar.
 * Return {question, yes} atau null.
 */
export function findOddsMarket(markets, keyword) {
  if (!Array.isArray(markets) || !keyword || typeof keyword !== 'string') return null
  const words = keyword.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  const parsed = markets
    .map((m) => ({
      question: String(m?.question ?? ''),
      yes: yesPct(m?.outcomes, m?.outcomePrices),
      vol: parseFloat(String(m?.volume24hr ?? '0')),
    }))
    .filter((m) => m.question.length > 0)
    .filter((m) => words.every((w) => keywordWordMatches(m.question.toLowerCase(), w)))
    .sort((a, b) => b.vol - a.vol)
  return parsed.length ? { question: parsed[0].question, yes: parsed[0].yes } : null
}

/** Peta question -> YES% dari array mentah Gamma (untuk cek odds alert). */
export function oddsYesByQuestion(markets) {
  const out = {}
  if (!Array.isArray(markets)) return out
  for (const m of markets) {
    const q = String(m?.question ?? '')
    if (q.length > 0) out[q] = yesPct(m?.outcomes, m?.outcomePrices)
  }
  return out
}

/**
 * Cek crossing odds alert terhadap YES% baru.
 * oddsAlerts: [{chatId, keyword, question, threshold, direction, fired}]
 * prevOdds / newOdds: {question: yesPct} — prev dari tick sebelumnya.
 * Sekali per crossing (seperti price alert): setelah fire, fired=true
 * sampai YES kembali ke sisi lain. Alert yang pasarnya tidak ditemukan
 * di data baru dilewati (tidak fire, tidak reset).
 * Return { fired: [{alert, yes}], alerts } (alerts = daftar ter-update).
 */
export function checkOddsAlertCrossings(oddsAlerts, prevOdds, newOdds) {
  const fired = []
  const updated = (oddsAlerts || []).map((a) => {
    const prev = prevOdds?.[a.question]
    const now = newOdds?.[a.question]
    if (typeof prev !== 'number' || typeof now !== 'number') return a
    const target = a.threshold
    if (a.direction === 'above') {
      if (!a.fired && prev < target && now >= target) {
        fired.push({ alert: a, yes: now })
        return { ...a, fired: true }
      }
      if (a.fired && now < target) return { ...a, fired: false }
    } else {
      if (!a.fired && prev > target && now <= target) {
        fired.push({ alert: a, yes: now })
        return { ...a, fired: true }
      }
      if (a.fired && now > target) return { ...a, fired: false }
    }
    return a
  })
  return { fired, alerts: updated }
}

function yesPct(outcomes, prices) {
  const parse = (v) => {
    if (Array.isArray(v)) return v.map(String)
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : [] } catch { return [] } }
    return []
  }
  const oc = parse(outcomes)
  const pr = parse(prices)
  if (!pr.length) return 0
  const idx = oc.findIndex((o) => o.toLowerCase() === 'yes')
  const p = parseFloat(pr[idx >= 0 ? idx : 0] ?? '0')
  return Math.round((Number.isFinite(p) ? p : 0) * 100)
}

export const HELP_TEXT = [
  'PolyGlance alerts — your price & odds watchdog for Even Realities G2.',
  'I watch live crypto prices and Polymarket odds, and ping you the moment something you care about crosses your line — even when the glasses app is closed.',
  '',
  'Quick start:',
  '1. /price — see live BTC, ETH, SOL, DOGE & XRP prices',
  '2. /alert btc below 60000 — get pinged when BTC drops below $60,000',
  '3. /list — see your alerts',
  '',
  'Commands:',
  '/alert btc above 58000 — alert when BTC crosses above $58,000',
  '/alert eth below 1900 — alert when ETH drops below $1,900',
  '/alertodds btc dip above 60 — alert when a Polymarket YES% rises above 60%',
  '/alertodds bitcoin below 40 — alert when a Polymarket YES% drops below 40%',
  '/price — live prices for BTC, ETH, SOL, DOGE & XRP with 24h change',
  '/odds — top 5 Polymarket crypto odds with volume',
  '/ask why is bitcoin down? — ask the market, answered from live data (2 lines)',
  '/whales — big Polymarket crypto trades ($1,000+)',
  '/brief — this morning\'s market digest',
  '/list — your alerts, with current values',
  '/remove 1 — remove alert #1',
  '/health — is the watcher alive?',
  '/help — this guide',
  '',
  'Tips:',
  '• Commands need full arguments — /alertodds on its own isn\'t enough, I\'ll show you how.',
  '• Direction typos get corrected — "about" works as "above".',
  '• Each alert fires once per crossing, then resets.',
  '• Alerts keep working even when the glasses app is closed.',
  '• Tap "Open PolyGlance" below the chat to open the Mini App — live prices, candles, odds & your alerts.',
  '',
  'Build: dorahacks.io/build/51900',
].join('\n')

// ---------------------------------------------------------------------------
// Rich replies — semua balasan bot yang kaya (dipakai worker.js + watcher.js).
// Semua teks English. Builder murni: data masuk, string keluar.
// ---------------------------------------------------------------------------

/** Harga adaptif: BTC $60,928 · ETH $1,699 · SOL $71 · DOGE $0.0567 · XRP $0.96. */
export function fmtPrice(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '?'
  if (n >= 100) return '$' + Math.round(n).toLocaleString('en-US')
  const decimals = n >= 1 ? 2 : 4
  return '$' + n.toFixed(decimals).replace(/\.?0+$/, '')
}

/** Volume ringkas: $1.2M · $850K · $42. */
export function fmtVolume(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '$0'
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K'
  return '$' + Math.round(n)
}

/**
 * Parse stats Coinbase Exchange (products/<COIN>-USD/stats).
 * open = harga 24 jam lalu; high/low = high/low 24 jam.
 * Return {open, last, high, low, changePct} atau null.
 */
export function parseCoinbaseStats(data) {
  const open = parseFloat(String(data?.open ?? ''))
  const last = parseFloat(String(data?.last ?? ''))
  const high = parseFloat(String(data?.high ?? ''))
  const low = parseFloat(String(data?.low ?? ''))
  if (!Number.isFinite(open) || open <= 0 || !Number.isFinite(last) || last <= 0) return null
  return {
    open,
    last,
    high: Number.isFinite(high) ? high : null,
    low: Number.isFinite(low) ? low : null,
    changePct: ((last - open) / open) * 100,
  }
}

/**
 * Parse candles Coinbase Exchange: [time, low, high, open, close, volume],
 * terbaru dulu. Return tertua-dulu [{t, low, high, open, close, volume}] atau null.
 */
export function parseCoinbaseCandles(data) {
  if (!Array.isArray(data)) return null
  const out = []
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 5) continue
    const [t, low, high, open, close, volume] = row.map(Number)
    if (![t, low, high, open, close].every(Number.isFinite)) continue
    out.push({ t, low, high, open, close, volume: Number.isFinite(volume) ? volume : null })
  }
  if (!out.length) return null
  return out.sort((a, b) => a.t - b.t)
}

/** Parse Fear & Greed Index (api.alternative.me/fng). Return {value, label} atau null. */
export function parseFearGreed(data) {
  const item = data?.data?.[0]
  const value = parseInt(String(item?.value ?? ''), 10)
  if (!Number.isFinite(value) || value < 0 || value > 100) return null
  return { value, label: String(item?.value_classification ?? '') || '—' }
}

/** Countdown ke market close: "closes in 12d 4h" / "closes in 3h 20m" / "closes in 45m" / "closed". */
export function fmtCountdown(endIso, nowMs = Date.now()) {
  const end = Date.parse(endIso)
  if (!Number.isFinite(end)) return null
  const diff = end - nowMs
  if (diff <= 0) return 'closed'
  const m = Math.floor(diff / 60000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  if (d > 0) return `closes in ${d}d ${h}h`
  if (h > 0) return `closes in ${h}h ${mm}m`
  return `closes in ${mm}m`
}

/** Gabung candle 1 jam jadi candle lebih besar (mis. 4 x 1h = 1 candle 4h).
 * Coinbase Exchange hanya mengizinkan granularity 60/300/900/3600/21600/86400 —
 * 4h (14400) TIDAK valid, jadi 4h dihitung dari candle 1h. */
export function aggregateCandles(candles, n) {
  if (!Array.isArray(candles) || candles.length < n) return null
  const out = []
  for (let i = 0; i + n <= candles.length; i += n) {
    const g = candles.slice(i, i + n)
    out.push({
      t: g[0].t,
      open: g[0].open,
      close: g[g.length - 1].close,
      high: Math.max(...g.map((c) => c.high)),
      low: Math.min(...g.map((c) => c.low)),
      volume: g.reduce((s, c) => s + (c.volume || 0), 0),
    })
  }
  return out.length ? out : null
}

/** SVG candlestick ringan (tanpa library): hijau naik, merah turun, tooltip OHLC per candle. */
export function candlesSvg(candles, { width = 640, height = 180 } = {}) {
  if (!Array.isArray(candles) || candles.length === 0) return ''
  const padL = 8, padR = 8, padT = 10, padB = 20
  let lo = Infinity, hi = -Infinity
  for (const c of candles) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high) }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return ''
  const span = hi - lo
  lo -= span * 0.03
  hi += span * 0.03
  const y = (v) => padT + ((hi - v) / (hi - lo)) * (height - padT - padB)
  const slot = (width - padL - padR) / candles.length
  const bodyW = Math.max(2, slot * 0.62)
  const parts = [`<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Candlestick chart">`]
  candles.forEach((c, i) => {
    const cx = padL + slot * i + slot / 2
    const up = c.close >= c.open
    const color = up ? '#16a34a' : '#dc2626'
    const top = y(Math.max(c.open, c.close))
    const bot = y(Math.min(c.open, c.close))
    const h = Math.max(1.5, bot - top)
    parts.push(`<line x1="${cx.toFixed(1)}" y1="${y(c.high).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${color}" stroke-width="1.5"/>`)
    parts.push(`<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"><title>O ${fmtPrice(c.open)} · H ${fmtPrice(c.high)} · L ${fmtPrice(c.low)} · C ${fmtPrice(c.close)}</title></rect>`)
  })
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const fmtT = (t) => {
    const d = new Date(t * 1000)
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:00 UTC`
  }
  parts.push(`<text x="${padL}" y="${height - 5}" font-size="10" fill="#6b7280">${fmtT(candles[0].t)}</text>`)
  parts.push(`<text x="${width - padR}" y="${height - 5}" font-size="10" fill="#6b7280" text-anchor="end">${fmtT(candles[candles.length - 1].t)}</text>`)
  parts.push('</svg>')
  return parts.join('')
}

/** Sparkline kecil dari deret harga (closes): polyline hijau naik / merah turun. */
export function sparklineSvg(values, { width = 96, height = 28 } = {}) {
  if (!Array.isArray(values)) return ''
  const nums = values.filter((v) => Number.isFinite(v))
  if (nums.length < 2) return ''
  const lo = Math.min(...nums)
  const hi = Math.max(...nums)
  const span = hi - lo || 1
  const x = (i) => (i / (nums.length - 1)) * width
  const y = (v) => 2 + ((hi - v) / span) * (height - 4)
  const pts = nums.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const color = nums[nums.length - 1] >= nums[0] ? '#16a34a' : '#dc2626'
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="24h sparkline"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`
}

/** 5 market odds teratas (crypto dulu, lalu volume) — data terstruktur untuk bot + /app. */
export function topOddsMarkets(markets, n = 5, nowMs = Date.now()) {
  if (!Array.isArray(markets)) return []
  const parsed = markets
    .map((m) => {
      const slug = String(m?.slug ?? '')
      const eventSlug = String(m?.events?.[0]?.slug ?? '')
      return {
        question: String(m?.question ?? ''),
        yes: yesPct(m?.outcomes, m?.outcomePrices),
        vol: parseFloat(String(m?.volume24hr ?? '0')),
        slug,
        eventSlug,
        // URL kanonis Polymarket: /event/<event-slug>/<market-slug>.
        // /event/<market-slug> saja = soft 404 (HTTP 200 tapi "Page not found"):
        // market slug BUKAN event slug (mis. event "what-price-will-bitcoin-hit-before-2027"
        // vs market "...-2026-527-627-868-...").
        url: slug
          ? (eventSlug ? `https://polymarket.com/event/${eventSlug}/${slug}` : `https://polymarket.com/event/${slug}`)
          : '',
        countdown: fmtCountdown(m?.endDate, nowMs),
      }
    })
    .filter((m) => m.question.length > 0)
    .sort((a, b) => b.vol - a.vol)
  const crypto = parsed.filter((m) => CRYPTO_KEYWORD.test(m.question))
  return (crypto.length >= n ? crypto : parsed).slice(0, n)
}

/** 5 odds teratas -> teks kaya untuk /odds: question lengkap + YES% + volume + countdown + link. */
export function formatOddsRich(markets, n = 5, nowMs = Date.now()) {
  return topOddsMarkets(markets, n, nowMs).map((m, i) => {
    const lines = [
      `${i + 1}. ${m.question}`,
      `   YES ${m.yes}% · vol ${fmtVolume(m.vol)}` + (m.countdown ? ` · ${m.countdown}` : ''),
    ]
    if (m.url) lines.push(`   ${m.url.replace(/^https:\/\//, '')}`)
    return lines.join('\n')
  })
}

/** Jarak nilai sekarang ke ambang alert: "$969 above the $60,000 threshold" / "13 pts below the 60% threshold". */
export function alertDistance(alert, current) {
  if (typeof alert?.threshold === 'number') {
    if (typeof current !== 'number') return null
    const diff = current - alert.threshold
    const abs = Math.abs(diff)
    if (abs === 0) return 'right at the threshold'
    return `${abs} pt${abs === 1 ? '' : 's'} ${diff > 0 ? 'above' : 'below'} the ${alert.threshold}% threshold`
  }
  if (typeof current !== 'number' || typeof alert?.price !== 'number') return null
  const diff = current - alert.price
  const abs = Math.abs(diff)
  if (abs === 0) return 'right at the threshold'
  return `${fmtUsd(abs)} ${diff > 0 ? 'above' : 'below'} the ${fmtUsd(alert.price)} threshold`
}

/** Alert milik satu chat (price + odds, nomor urut gabungan — dipakai /list dan /remove). */
export function myAlerts(alerts, oddsAlerts, chatId) {
  const priceMine = (alerts || [])
    .map((a, i) => ({ a, i, kind: 'price' }))
    .filter(({ a }) => a.chatId === chatId)
  const oddsMine = (oddsAlerts || [])
    .map((a, i) => ({ a, i, kind: 'odds' }))
    .filter(({ a }) => a.chatId === chatId)
  return [...priceMine, ...oddsMine]
}

/** Satu baris alert untuk /list dan /app: aset/pasar, arah, ambang, nilai sekarang, jarak, status. */
export function formatAlertLine(a, kind, n, lastPrices, lastOdds) {
  if (kind === 'price') {
    const cur = lastPrices?.[a.coin.toLowerCase()]
    const dist = alertDistance(a, cur)
    const now = typeof cur === 'number' ? ` — now ${fmtUsd(cur)}` : ''
    const d = dist ? ` · ${dist}` : ''
    return `${n}. ${a.coin} ${a.direction} ${fmtUsd(a.price)}${now}${d} · ${a.fired ? 'TRIGGERED' : 'WAITING'}`
  }
  const curYes = typeof lastOdds?.[a.question] === 'number' ? lastOdds[a.question] : a.lastYes
  const dist = alertDistance({ threshold: a.threshold }, curYes)
  const now = typeof curYes === 'number' ? ` — now ${curYes}%` : ''
  const d = dist ? ` · ${dist}` : ''
  return `${n}. ODDS "${a.question}" YES ${a.direction} ${a.threshold}%${now}${d} · ${a.fired ? 'TRIGGERED' : 'WAITING'}`
}

/** /list kaya: semua alert (price + odds) dengan detail + nomor untuk /remove. */
export function formatAlertsList(alerts, oddsAlerts, chatId, lastPrices, lastOdds) {
  const all = myAlerts(alerts, oddsAlerts, chatId)
  if (all.length === 0) return 'No alerts yet. Set one with /alert btc below 60000 or /alertodds btc dip above 60.'
  const lines = all.map(({ a, kind }, i) => formatAlertLine(a, kind, i + 1, lastPrices, lastOdds))
  return `Your alerts (${all.length}):\n${lines.join('\n')}\n\nRemove one with /remove <number> — e.g. /remove 1.`
}

/** /price kaya: 5 koin + perubahan 24 jam + sumber + jam update.
 * %24h TIDAK PERNAH hilang diam-diam: kalau stats gagal (terbukti 26 Nov
 * 13:16 WIB — SOL/DOGE tanpa %24h sementara spot lolos semua), tampilkan
 * "(— 24h)" dengan jelas. opts.live = pesan live-update (footer). */
export function formatPriceReply(coins, source, updatedAt, opts = {}) {
  if (!coins.length) return 'No prices right now — try again in a minute.'
  const lines = coins.map((c) => {
    const ch = typeof c.changePct === 'number' ? ` (${c.changePct >= 0 ? '+' : ''}${c.changePct.toFixed(1)}% 24h)` : ' (— 24h)'
    const stale = c.stale ? ' (last known)' : ''
    return `${c.sym} ${fmtPrice(c.price)}${ch}${stale}`
  })
  let text = `Live prices (${source}, ${updatedAt}):\n${lines.join('\n')}`
  if (opts.live) text += `\n\n${LIVE_PRICE_FOOTER}`
  return text
}

// ---------------------------------------------------------------------------
// Live /price — pesan /price diedit tiap tick cron (60 detik) selama 30 menit.
// Telegram mengizinkan bot mengedit pesannya sendiri (editMessageText).
// Satu entri per chat (pesan /price terbaru); entri disimpan di KV key
// sendiri (polyglance-liveprice-v1) supaya tidak menimpa state lain.
// ---------------------------------------------------------------------------

/** Berapa lama pesan /price terus di-update setelah dikirim (30 menit). */
export const LIVE_PRICE_TTL_MS = 30 * 60 * 1000

/** Footer pesan /price live — memberitahu pengguna angkanya bergerak + batasnya. */
export const LIVE_PRICE_FOOTER = 'Live — updates every 60s for 30 min · send /price again for a fresh snapshot'

/**
 * Lacak pesan /price terbaru satu chat (ganti entri lama chat yang sama —
 * /price baru berarti pesan lama berhenti di-update). Murni.
 * Entry: { chatId, messageId, sentAt } (sentAt = epoch ms).
 */
export function trackLivePrice(messages, chatId, messageId, nowMs = Date.now()) {
  const list = (messages || []).filter((m) => m.chatId !== chatId)
  list.push({ chatId, messageId, sentAt: nowMs })
  return list
}

/** Buang entri live-price yang umurnya >= TTL. Return { live, expired }. */
export function pruneLivePrices(messages, nowMs = Date.now()) {
  const live = []
  const expired = []
  for (const m of messages || []) {
    if (typeof m?.sentAt !== 'number' || nowMs - m.sentAt >= LIVE_PRICE_TTL_MS) expired.push(m)
    else live.push(m)
  }
  return { live, expired }
}

/** /health kaya: alive, last check, harga, jumlah alert + chats, webhook, price source. */
export function formatHealthReply({ lastTick, lastPrices, priceSource, yourPrice, yourOdds, chats, webhookActive }) {
  const btc = lastPrices ? fmtUsd(lastPrices.btc) : '?'
  const eth = lastPrices ? fmtUsd(lastPrices.eth) : '?'
  return [
    'Watcher alive.',
    `Last check: ${lastTick || 'never'}`,
    `BTC ${btc} · ETH ${eth} (${priceSource || '?'})`,
    `Your alerts: ${yourPrice} price, ${yourOdds} odds · Chats: ${chats}`,
    `Webhook: ${webhookActive ? 'online' : 'off (polling)'} · Price source: ${priceSource || '?'}`,
  ].join('\n')
}

/** Konfirmasi /alert kaya: apa yang di-set, nilai sekarang, jarak, kapan bunyi. */
export function formatAlertSetReply(alert, currentPrice) {
  const cur = typeof currentPrice === 'number' ? fmtUsd(currentPrice) : '?'
  const dist = alertDistance(alert, currentPrice)
  return [
    `Alert set: ${alert.coin} ${alert.direction} ${fmtUsd(alert.price)}`,
    `Now: ${alert.coin} ${cur} · ${alert.fired ? 'TRIGGERED' : 'WAITING'}${dist ? ` · ${dist}` : ''}`,
    `I'll ping you when ${alert.coin} crosses ${alert.direction} ${fmtUsd(alert.price)}.`,
  ].join('\n')
}

/** Konfirmasi /alertodds kaya. */
export function formatOddsAlertSetReply(alert, currentYes) {
  const cur = typeof currentYes === 'number' ? `${currentYes}%` : '?'
  const dist = alertDistance({ threshold: alert.threshold }, currentYes)
  return [
    `Odds alert set: "${alert.question}" YES ${alert.direction} ${alert.threshold}%`,
    `Now: YES ${cur} · ${alert.fired ? 'TRIGGERED' : 'WAITING'}${dist ? ` · ${dist}` : ''}`,
    `I'll ping you when YES% crosses ${alert.direction} ${alert.threshold}%.`,
  ].join('\n')
}

/** Konfirmasi /remove kaya: persis apa yang dihapus + sisa alert. */
export function formatRemovedReply(removed, kind, remaining) {
  const what = kind === 'price'
    ? `${removed.coin} ${removed.direction} ${fmtUsd(removed.price)}`
    : `ODDS "${removed.question}" YES ${removed.direction} ${removed.threshold}%`
  return `Removed: ${what}\nYou have ${remaining} alert${remaining === 1 ? '' : 's'} left. See them with /list.`
}

// ---------------------------------------------------------------------------
// v8.2 — ASK / WHALES / MOOD / Morning Brief + hemat KV.
// Semua fungsi di bawah murni (data masuk, nilai keluar) — bisa dites di Node.
// ---------------------------------------------------------------------------

/** Jawaban penolakan ASK — dipakai pre-check Worker DAN system prompt Groq
  (teksnya sama persis supaya perilaku konsisten di kedua jalur). */
export const ASK_REFUSAL = 'I can share live data, not predictions or advice.'

/**
 * Pre-check pertanyaan ASK: true kalau pertanyaan meminta prediksi harga
 * atau financial advice — harus ditolak TANPA memanggil Groq (hemat kuota
 * + jawaban deterministik). Pertanyaan faktual ("why is bitcoin down?",
 * "is bitcoin fear or greed?") lolos — LLM menjawab dari data live.
 * Aturan: (1) should/shall i|we, (2) kata prediksi/advice, (3) when/best
 * time + buy/sell, (4) will + kata target harga, (5) buy/sell + koin +
 * kata "sekarang/baik". */
export function isAskRefusalNeeded(question) {
  if (!question || typeof question !== 'string') return false
  const q = question.toLowerCase()
  if (/\b(should|shall)\s+(i|we)\b/.test(q)) return true
  if (/\b(invest|prediction|predict|forecast|advice|recommend)\b/.test(q)) return true
  if (/\b(when|best time)\b.*\b(buy|sell)\b/.test(q)) return true
  if (/\bwill\b.*\b(reach|hit|go to|rise to|fall to|drop to|be at)\b/.test(q)) return true
  if (/\b(buy|sell)\b.*\b(bitcoin|btc|ethereum|eth|solana|sol|crypto)\b/.test(q) && /\b(should|now|today|good)\b/.test(q)) return true
  return false
}

/** System prompt Groq chat untuk ASK — jawaban WAJIB dari data live,
  maks 2 baris pendek, tanpa prediksi / advice. */
export const ASK_SYSTEM_PROMPT = 'You are PolyGlance, a market-data summarizer on smart glasses. Answer ONLY from the live data below. Max 2 short lines. Quote real numbers from the data. NEVER predict future prices, NEVER give financial advice, NEVER recommend buying or selling. If the question asks for a prediction or advice, reply exactly: "I can share live data, not predictions or advice." If the data does not cover the question, say so in one line. English only, plain ASCII.'

/** Pesan Groq chat untuk ASK: system + user (data live + pertanyaan). */
export function buildAskMessages(question, dataLines) {
  const data = (dataLines || []).filter(Boolean).join('\n')
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  return [
    { role: 'system', content: ASK_SYSTEM_PROMPT },
    { role: 'user', content: `Live data (UTC ${stamp}):\n${data || 'no live data available'}\n\nQuestion: ${question}` },
  ]
}

/** Parse jawaban Groq chat -> maks 2 baris non-kosong, tiap baris <=100
  karakter (kacamata membungkus ulang ke <=34 karakter/baris sendiri).
  Return null kalau tidak ada isi (pemanggil menampilkan pesan gagal). */
export function parseAskAnswer(content) {
  if (!content || typeof content !== 'string') return null
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2)
  if (lines.length === 0) return null
  return lines.map((l) => (l.length > 100 ? l.slice(0, 100) : l)).join('\n')
}

// ---------------------------------------------------------------------------
// v8.3 — ASK-WEB (POST /ask-web): otak KEDUA, khusus website.
// /ask (kacamata) sengaja sempit: live-data only, max 2 baris. /ask-web
// menjawab pertanyaan UMUM pengunjung website — produk + pengetahuan crypto
// umum + data live yang sama. Larangan prediksi/advice TETAP berlaku
// (pre-check isAskRefusalNeeded yang sama + system prompt yang sama
// tegasnya). Jawaban boleh lebih panjang (web, bukan kacamata): max ~6
// baris pendek. Rate cap TERPISAH dari /ask (lihat worker.js).
// ---------------------------------------------------------------------------

/** System prompt Groq chat untuk ASK-WEB — asisten umum website PolyGlance.
  Tahu produk + crypto umum, jawab dari data live kalau soalnya soal pasar
  saat ini. Tetap: TIDAK PERNAH prediksi harga / advice / rekomendasi
  beli-jual — kalau ditanya itu, balas persis ASK_REFUSAL. */
export const ASK_WEB_SYSTEM_PROMPT = [
  'You are PolyGlance, the friendly assistant on the PolyGlance website.',
  'PolyGlance is an app for Even Realities G2 smart glasses: live crypto prices (BTC, ETH, SOL, DOGE, XRP), Polymarket odds, paper trading with $10,000 virtual money, voice commands, Hyperliquid perpetual prices with funding and open interest (read-only), whale trades over $1,000, a market mood view, and a Telegram bot @polyglance_alerts_bot with price alerts, odds alerts and a Morning Brief at 08:00 WIB.',
  'It was built solo by developer ilham (ilham270207) — one person, not a team.',
  'People can try PolyGlance without glasses: the simulator on this website, the Telegram bot, or the Android companion APK. PolyGlance is free. It is a hackathon build for the Even Realities Heads Up hackathon (dorahacks.io/build/51900).',
  'You also know general crypto: what Bitcoin and Ethereum are, how Polymarket prediction markets work (YES/NO shares, prices reflect probabilities), and what the Fear & Greed Index means.',
  'For questions about current prices, odds or market data, answer ONLY from the live data below and quote real numbers from it. For general questions, answer from your own knowledge. Max 6 short lines. NEVER predict future prices, NEVER give financial advice, NEVER recommend buying or selling. If the question asks for a prediction or advice, reply exactly: "I can share live data, not predictions or advice." If the live data does not cover a market question, say so in one line. English only, plain ASCII.',
].join(' ')

/** Pesan Groq chat untuk ASK-WEB: system + user (data live + pertanyaan). */
export function buildAskWebMessages(question, dataLines) {
  const data = (dataLines || []).filter(Boolean).join('\n')
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  return [
    { role: 'system', content: ASK_WEB_SYSTEM_PROMPT },
    { role: 'user', content: `Live data (UTC ${stamp}):\n${data || 'no live data available'}\n\nQuestion: ${question}` },
  ]
}

/** Parse jawaban Groq chat untuk web -> maks 6 baris non-kosong, tiap baris
  <=200 karakter (web punya ruang, bukan kacamata). Return null kalau tidak
  ada isi (pemanggil menampilkan pesan gagal). */
export function parseAskWebAnswer(content) {
  if (!content || typeof content !== 'string') return null
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 6)
  if (lines.length === 0) return null
  return lines.map((l) => (l.length > 200 ? l.slice(0, 200) : l)).join('\n')
}

/** Validasi pertanyaan /ask-web: string 3..500 karakter (setelah trim).
  Dipakai handleAskWeb di worker.js — batas 500 (bukan 200 seperti /ask)
  karena pengunjung website mengetik pertanyaan yang lebih panjang. */
export function isValidAskWebQuestion(question) {
  if (!question || typeof question !== 'string') return false
  const len = question.trim().length
  return len >= 3 && len <= 500
}

/** Rate cap /ask-web: maks 60 pertanyaan per menit per isolate (counter
  terpisah dari /ask — lihat worker.js askWebGroq). */
export const ASK_WEB_RATE_LIMIT_PER_MIN = 60

/** Header CORS /ask-web (dipakai worker.js untuk OPTIONS + semua respons
  POST): website pengunjung mana pun boleh POST dari browser. */
export const ASK_WEB_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

/** Format USD ringkas untuk WHALES: $12.4K · $150K · $1.2M. */
export function formatWhaleUsd(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return '$?'
  if (usd >= 1e6) return '$' + (usd / 1e6).toFixed(1) + 'M'
  if (usd >= 1e4) {
    const v = (usd / 1e3).toFixed(1)
    return '$' + (v.endsWith('.0') ? v.slice(0, -2) : v) + 'K'
  }
  if (usd >= 1e3) return '$' + (usd / 1e3).toFixed(1) + 'K'
  return '$' + Math.round(usd)
}

/**
 * Parse trade Polymarket data-api v2 /trades -> trade paus crypto.
 * Filter: nilai (size x price) >= $1.000 DAN pertanyaan mengandung keyword
 * crypto (regex yang sama dengan topOddsMarkets). Dedupe berdasarkan
 * transactionHash (fallback: question+timestamp+size). Urut terbaru dulu,
 * maks 10. Return [{question, outcome, usd, pct, trader, mins}].
 * Field API defensif (alias): title | market.question | question | slug;
 * outcome | outcomeIndex (0=Yes, 1=No di pasar biner); name | pseudonym |
 * maker; timestamp detik ATAU milidetik. */
export function parseWhaleTrades(trades, nowMs = Date.now()) {
  if (!Array.isArray(trades)) return []
  const seen = new Set()
  const out = []
  for (const t of trades) {
    const size = parseFloat(String(t?.size ?? ''))
    const price = parseFloat(String(t?.price ?? ''))
    if (!Number.isFinite(size) || !Number.isFinite(price) || size <= 0 || price <= 0) continue
    const usd = size * price
    if (usd < 1000) continue
    const question = String(t?.title ?? t?.market?.question ?? t?.question ?? t?.slug ?? '').trim()
    if (!question) continue
    if (!CRYPTO_KEYWORD.test(question)) continue
    const tx = String(t?.transactionHash ?? t?.transaction_hash ?? '')
    const key = tx || `${question}|${t?.timestamp}|${size}`
    if (seen.has(key)) continue
    seen.add(key)
    let outcome = String(t?.outcome ?? '').trim().toUpperCase()
    if (!outcome) outcome = t?.outcomeIndex === 1 ? 'NO' : 'YES'
    const trader = String(t?.name ?? t?.pseudonym ?? t?.maker ?? '').trim().slice(0, 20) || 'anon'
    const tsRaw = Number(t?.timestamp)
    const tsMs = Number.isFinite(tsRaw) ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000) : nowMs
    const mins = Math.max(0, Math.round((nowMs - tsMs) / 60000))
    out.push({
      question,
      outcome,
      usd: Math.round(usd),
      pct: Math.round(price * 100),
      trader,
      mins,
      _ts: tsMs,
    })
  }
  out.sort((a, b) => b._ts - a._ts)
  return out.slice(0, 10).map(({ _ts, ...rest }) => rest)
}

/** Trade paus -> teks Telegram /whales (maks 5 baris trade). */
export function formatWhalesReply(trades) {
  if (!trades || trades.length === 0) return 'No big crypto trades ($1,000+) in the last few minutes — try again soon.'
  const age = (mins) => (mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`)
  const lines = trades.slice(0, 5).map((t, i) =>
    `${i + 1}. ${formatWhaleUsd(t.usd)} ${t.outcome} "${t.question}" @ ${t.pct}% — ${t.trader}, ${age(t.mins)}`)
  return 'Big Polymarket crypto trades ($1,000+):\n' + lines.join('\n')
}

/**
 * Level MOOD — cerminan dari src/mood.ts (kacamata). Skor: F&G 0..100 ->
 * -2..+2; arah BTC -> -1..+1; funding rata-rata -> -1..+1. Total -4..+4:
 * <=-2 risk-off, -1 cautious, 0 neutral, +1..+2 risk-on, >=+3 euphoric.
 * Data kosong tidak ikut skor (netral). */
export function computeMoodLevel({ fng, btcChg, fundingAvg }) {
  let score = 0
  if (typeof fng === 'number') {
    if (fng <= 24) score -= 2
    else if (fng <= 44) score -= 1
    else if (fng >= 76) score += 2
    else if (fng >= 55) score += 1
  }
  if (typeof btcChg === 'number') {
    if (btcChg <= -3) score -= 1
    else if (btcChg >= 3) score += 1
  }
  if (typeof fundingAvg === 'number') {
    if (fundingAvg <= -0.0005) score -= 1
    else if (fundingAvg >= 0.001) score += 1
  }
  if (score <= -2) return 'risk-off'
  if (score === -1) return 'cautious'
  if (score === 0) return 'neutral'
  if (score <= 2) return 'risk-on'
  return 'euphoric'
}

/**
 * Morning Brief — digest Telegram 08:00 WIB (01:00 UTC), sekali per hari.
 * coins: [{sym, price, changePct}] (format sama dengan formatPriceReply);
 * fng: {value, label} | null; topOdds: [{question, yes}] (dari
 * topOddsMarkets, maks 3). */
export function formatMorningBrief({ coins, fng, topOdds, dateLabel }) {
  const lines = [`Morning brief — ${dateLabel || 'today'}:`]
  if (coins && coins.length) {
    lines.push(coins.map((c) => {
      const ch = typeof c.changePct === 'number' ? ` (${c.changePct >= 0 ? '+' : ''}${c.changePct.toFixed(1)}% 24h)` : ''
      return `${c.sym} ${fmtPrice(c.price)}${ch}`
    }).join(' · '))
  }
  if (fng) lines.push(`Fear & Greed: ${fng.value} (${fng.label})`)
  if (topOdds && topOdds.length) {
    lines.push('Top odds:')
    topOdds.slice(0, 3).forEach((m, i) => lines.push(`${i + 1}. ${m.question} — YES ${m.yes}%`))
  }
  lines.push('Open the Mini App from the chat menu for candles & alerts.')
  return lines.join('\n')
}

/**
 * Apakah Morning Brief jatuh tempo SEKARANG? true hanya di jam 01:00 UTC
 * (08:00 WIB) dan belum dikirim hari ini (lastSentDate = 'YYYY-MM-DD' UTC).
 * Dipakai tick() — JANGAN panggil di luar jam 01:00 UTC supaya tidak ada
 * baca KV yang tidak perlu (lihat catatan hemat KV di worker.js). */
export function briefDue(lastSentDate, nowMs = Date.now()) {
  const d = new Date(nowMs)
  if (d.getUTCHours() !== 1) return false
  const today = d.toISOString().slice(0, 10)
  return lastSentDate !== today
}

// ---------------------------------------------------------------------------
// Hemat KV (v8.2) — akun Cloudflare ilham kena limit KV harian 26 Nov
// (50% jam 16:27 WIB, 90% jam 22:44 WIB; reset 00:00 UTC). Meter yang
// kehabisan hampir pasti WRITES (batas gratis 1.000/hari): tick menulis key
// prices 1x/menit hanya karena lastTick berubah = 1.440 writes/hari, dan
// kurva akrualnya cocok (570 writes ~09:27 UTC = 50%, 944 ~15:44 UTC = 90%).
// Perbaikan: tahan penulisan key prices sampai >=10 menit sejak lastTick
// tersimpan (lihat worker.js tick). Deteksi crossing alert TETAP aman:
// cek crossing tiap tick memakai harga segar vs harga tersimpan terakhir
// (jendela deteksi justru melebar, bukan menyempit).
// ---------------------------------------------------------------------------

/** Jeda minimum antar penulisan key prices (10 menit). */
export const PRICES_PERSIST_MIN_MS = 10 * 60 * 1000

/** true kalau key prices BOLEH ditulis sekarang (sudah >=10 menit sejak
  lastTick tersimpan, atau belum pernah tersimpan). */
export function shouldPersistPrices(prevLastTickIso, nowMs = Date.now()) {
  const prev = Date.parse(prevLastTickIso || '')
  if (!Number.isFinite(prev)) return true
  return nowMs - prev >= PRICES_PERSIST_MIN_MS
}
