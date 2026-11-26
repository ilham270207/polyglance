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
    // /alert btc above 58000 | /alert eth below 1900
    const coinRaw = (parts[1] || '').toLowerCase()
    const coin = coinRaw === 'btc' || coinRaw === 'bitcoin' ? 'BTC'
      : coinRaw === 'eth' || coinRaw === 'ethereum' ? 'ETH' : null
    const dirRaw = (parts[2] || '').toLowerCase()
    const direction = dirRaw === 'above' || dirRaw === 'over' || dirRaw === '>' ? 'above'
      : dirRaw === 'below' || dirRaw === 'under' || dirRaw === '<' ? 'below' : null
    const price = parseFloat(String(parts[3] || '').replace(/[$,]/g, ''))
    if (!coin || !direction || !Number.isFinite(price) || price <= 0) return null
    return { cmd: 'alert', coin, direction, price }
  }
  if (cmd === '/alertodds') {
    // /alertodds <keyword...> above|below <pct> — mis. /alertodds btc dip above 60
    // /alertodds bitcoin below 40. Keyword = semua kata sebelum arah.
    const dirs = ['above', 'over', '>', 'below', 'under', '<']
    const di = parts.findIndex((p) => dirs.includes(p.toLowerCase()))
    if (di < 2) return null
    const dirRaw = parts[di].toLowerCase()
    const direction = dirRaw === 'above' || dirRaw === 'over' || dirRaw === '>' ? 'above' : 'below'
    const pct = parseFloat(String(parts[di + 1] || '').replace(/[%]/g, ''))
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null
    const keyword = parts.slice(1, di).join(' ').trim()
    if (!keyword) return null
    return { cmd: 'alertodds', keyword, direction, pct }
  }
  return null
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

/**
 * Cari satu market Polymarket dari array mentah Gamma berdasarkan keyword.
 * Semua kata keyword harus muncul di question (case-insensitive); kalau
 * beberapa cocok, pilih volume24hr terbesar. Return {question, yes} atau null.
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
    .filter((m) => words.every((w) => m.question.toLowerCase().includes(w)))
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

/** 3 odds crypto teratas dari array mentah Gamma -> baris teks untuk /odds. */
export function formatOddsTop(markets, n = 3) {
  if (!Array.isArray(markets)) return []
  const parsed = markets
    .map((m) => ({
      question: String(m?.question ?? ''),
      yes: yesPct(m?.outcomes, m?.outcomePrices),
      vol: parseFloat(String(m?.volume24hr ?? '0')),
    }))
    .filter((m) => m.question.length > 0)
    .sort((a, b) => b.vol - a.vol)
  const crypto = parsed.filter((m) => CRYPTO_KEYWORD.test(m.question))
  const top = (crypto.length >= n ? crypto : parsed).slice(0, n)
  return top.map((m) => {
    const q = m.question.replace(/^Will\s+/i, '')
    const short = q.length > 40 ? q.slice(0, 37) + '...' : q
    return `${short} YES ${m.yes}%`
  })
}

export const HELP_TEXT = [
  'PolyGlance alerts (@polyglance_alerts_bot) — price alerts for your glasses.',
  '',
  '/alert btc above 58000 — alert when BTC crosses $58,000',
  '/alert eth below 1900 — alert when ETH drops below $1,900',
  '/alertodds btc dip above 60 — alert when a Polymarket YES% crosses 60%',
  '/alertodds bitcoin below 40 — alert when a Polymarket YES% drops below 40%',
  '/price — current BTC/ETH price',
  '/odds — top 3 Polymarket crypto odds',
  '/list — your alerts',
  '/remove 1 — remove alert #1',
  '/health — is the watcher alive?',
  '/help — this message',
].join('\n')
