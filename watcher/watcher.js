// PolyGlance watcher — Node fallback (Termux di HP ilham, demo).
// Target utama adalah Cloudflare Worker (watcher/worker.js); file ini hanya
// untuk demo cepat tanpa akun Cloudflare: jalan di foreground Termux.
// Token HANYA dari env var POLYGLANCE_BOT_TOKEN — tidak pernah di file/repo.
// State di watcher/alerts.json (gitignored).
// Jalankan:  export POLYGLANCE_BOT_TOKEN=<token dari BotFather>
//            node watcher/watcher.js

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fmtUsd,
  friendlyReply,
  checkAlertCrossings,
  checkOddsAlertCrossings,
  findOddsMarket,
  oddsYesByQuestion,
  formatOddsRich,
  formatAlertsList,
  formatPriceReply,
  formatHealthReply,
  formatAlertSetReply,
  formatOddsAlertSetReply,
  formatRemovedReply,
  myAlerts,
  parseCoinGeckoPrices,
  parseCoinbaseSpot,
  parseCoinbaseStats,
  HELP_TEXT,
} from './core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_FILE = join(HERE, 'alerts.json')
const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd'
const COINBASE_BTC_URL = 'https://api.coinbase.com/v2/prices/BTC-USD/spot'
const COINBASE_ETH_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot'
const COINBASE_SPOT = (sym) => `https://api.coinbase.com/v2/prices/${sym}-USD/spot`
const COINBASE_STATS = (sym) => `https://api.exchange.coinbase.com/products/${sym}-USD/stats`
const PRICE_SYMBOLS = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP']
const GAMMA_URL =
  'https://gamma-api.polymarket.com/markets?limit=100&active=true&closed=false&order=volume24hr&ascending=false'

async function fetchWithTimeout(url, ms = 8000) {
  return fetch(url, { signal: AbortSignal.timeout(ms) })
}

/** Harga live 5 koin untuk /price — sama seperti worker.js (spot + stats Coinbase). */
async function fetchLivePrices(state) {
  const jobs = PRICE_SYMBOLS.map(async (sym) => {
    let price = null
    let changePct = null
    try {
      const res = await fetchWithTimeout(COINBASE_SPOT(sym))
      if (res.ok) price = parseCoinbaseSpot(await res.json())
    } catch { /* lanjut */ }
    try {
      const res = await fetchWithTimeout(COINBASE_STATS(sym))
      if (res.ok) {
        const st = parseCoinbaseStats(await res.json())
        if (st) {
          changePct = st.changePct
          if (price === null) price = st.last
        }
      }
    } catch { /* lanjut */ }
    if (price === null && state?.lastPrices) {
      const known = state.lastPrices[sym.toLowerCase()]
      if (typeof known === 'number') return { sym, price: known, changePct, stale: true }
    }
    if (price === null) return null
    return { sym, price, changePct, stale: false }
  })
  return (await Promise.all(jobs)).filter(Boolean)
}

const TOKEN = process.env.POLYGLANCE_BOT_TOKEN
if (!TOKEN) {
  console.error('POLYGLANCE_BOT_TOKEN belum diset. Jalankan:\n  export POLYGLANCE_BOT_TOKEN=<token dari @BotFather>')
  process.exit(1)
}
const tg = `https://api.telegram.org/bot${TOKEN}`

function emptyState() {
  return { offset: 0, chats: [], alerts: [], oddsAlerts: [], lastOdds: null, lastPrices: null, lastTick: null }
}

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return emptyState()
    return { ...emptyState(), ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }
  } catch {
    return emptyState()
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

async function sendMessage(chatId, text) {
  try {
    const res = await fetch(`${tg}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function handleCommand(state, chatId, parsed) {
  const now = new Date().toISOString()
  switch (parsed.cmd) {
    case 'start': {
      if (!state.chats.includes(chatId)) state.chats.push(chatId)
      await sendMessage(
        chatId,
        'Hi! I am @polyglance_alerts_bot, the PolyGlance alert bot.\n' +
          'Set a price alert and I will ping you when it hits — even when the glasses app is closed.\n\n' +
          HELP_TEXT,
      )
      return
    }
    case 'help':
      await sendMessage(chatId, HELP_TEXT)
      return
    case 'health': {
      const yourPrice = state.alerts.filter((a) => a.chatId === chatId).length
      const yourOdds = (state.oddsAlerts || []).filter((a) => a.chatId === chatId).length
      await sendMessage(
        chatId,
        formatHealthReply({
          lastTick: state.lastTick,
          lastPrices: state.lastPrices,
          priceSource: state.priceSource,
          yourPrice,
          yourOdds,
          chats: state.chats.length,
          webhookActive: false, // fallback Node selalu polling
        }),
      )
      return
    }
    case 'price': {
      const coins = await fetchLivePrices(state)
      const updated = new Date().toISOString().slice(11, 16) + ' UTC'
      await sendMessage(chatId, formatPriceReply(coins, 'Coinbase', updated))
      return
    }
    case 'odds': {
      try {
        const res = await fetch(GAMMA_URL)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const arr = Array.isArray(data) ? data : data?.markets ?? []
        const lines = formatOddsRich(arr, 5)
        await sendMessage(chatId, lines.length ? 'Top 5 Polymarket crypto odds:\n\n' + lines.join('\n\n') : 'No odds right now.')
      } catch {
        await sendMessage(chatId, 'Could not fetch odds right now.')
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
      await sendMessage(chatId, formatAlertSetReply(alert, cur))
      return
    }
    case 'alertodds': {
      try {
        const res = await fetch(GAMMA_URL)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const arr = Array.isArray(data) ? data : data?.markets ?? []
        const found = findOddsMarket(arr, parsed.keyword)
        if (!found) {
          await sendMessage(chatId, `No Polymarket market matches "${parsed.keyword}". Try another keyword, e.g. /alertodds bitcoin above 60`)
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
        await sendMessage(chatId, formatOddsAlertSetReply(alert, found.yes))
      } catch {
        await sendMessage(chatId, 'Could not fetch odds right now. Try again in a minute.')
      }
      return
    }
    case 'list': {
      await sendMessage(chatId, formatAlertsList(state.alerts, state.oddsAlerts, chatId, state.lastPrices, state.lastOdds))
      return
    }
    case 'remove': {
      const all = myAlerts(state.alerts, state.oddsAlerts, chatId)
      const target = all[parsed.index - 1]
      if (!target) {
        await sendMessage(
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
      await sendMessage(chatId, formatRemovedReply(removed, target.kind, remaining))
      return
    }
  }
}

async function tick() {
  const state = loadState()
  // Harga — CoinGecko dulu, Coinbase sebagai cadangan (CoinGecko bisa 403
  // dari Worker; Binance 451 dari AS).
  let prices = null
  try {
    const res = await fetch(COINGECKO_URL)
    if (res.ok) prices = parseCoinGeckoPrices(await res.json())
    else console.log('coingecko status:', res.status)
  } catch (e) {
    console.log('coingecko failed:', e.message)
  }
  if (!prices) {
    try {
      const [rb, re] = await Promise.all([fetch(COINBASE_BTC_URL), fetch(COINBASE_ETH_URL)])
      const btc = rb.ok ? parseCoinbaseSpot(await rb.json()) : null
      const eth = re.ok ? parseCoinbaseSpot(await re.json()) : null
      if (typeof btc === 'number' && typeof eth === 'number') prices = { btc, eth }
      else console.log('coinbase status:', rb.status, re.status)
    } catch (e) {
      console.log('coinbase failed:', e.message)
    }
  }
  if (prices) {
    const { fired, alerts } = checkAlertCrossings(state.alerts, state.lastPrices, prices)
    state.alerts = alerts
    for (const f of fired) {
      await sendMessage(
        f.alert.chatId,
        `${f.alert.coin} HIT ${fmtUsd(f.alert.price)}! Now ${fmtUsd(f.price)}. Set in PolyGlance.`,
      )
    }
    state.lastPrices = prices
  }
  if ((state.oddsAlerts || []).length > 0) {
    try {
      const res = await fetch(GAMMA_URL)
      if (res.ok) {
        const data = await res.json()
        const arr = Array.isArray(data) ? data : data?.markets ?? []
        const newOdds = oddsYesByQuestion(arr)
        const { fired, alerts } = checkOddsAlertCrossings(state.oddsAlerts, state.lastOdds, newOdds)
        state.oddsAlerts = alerts.map((a) => ({
          ...a,
          lastYes: typeof newOdds[a.question] === 'number' ? newOdds[a.question] : a.lastYes,
        }))
        for (const f of fired) {
          const short = f.alert.question.replace(/^Will\s+/i, '')
          const shortQ = short.length > 40 ? short.slice(0, 37) + '...' : short
          await sendMessage(
            f.alert.chatId,
            `ODDS ALERT: "${shortQ}" YES ${f.yes}% — crossed ${f.alert.direction} ${f.alert.threshold}%!`,
          )
        }
        state.lastOdds = newOdds
      }
    } catch (e) {
      console.log('gamma odds check failed:', e.message)
    }
  }
  try {
    const res = await fetch(`${tg}/getUpdates?offset=${state.offset || 0}&timeout=0&limit=50`)
    if (res.ok) {
      const data = await res.json()
      for (const u of data.result || []) {
        state.offset = u.update_id + 1
        const msg = u.message
        if (msg && typeof msg.text === 'string') {
          // friendlyReply TIDAK PERNAH null — pesan penolakan mentah sudah tidak dipakai lagi.
          const routed = friendlyReply(msg.text)
          if (routed.parsed) await handleCommand(state, msg.chat.id, routed.parsed)
          else await sendMessage(msg.chat.id, routed.usage)
        }
      }
    }
  } catch (e) {
    console.log('getUpdates failed:', e.message)
  }
  state.lastTick = new Date().toISOString()
  saveState(state)
  console.log(`[${state.lastTick}] tick ok — BTC ${state.lastPrices ? fmtUsd(state.lastPrices.btc) : '?'}, alerts: ${state.alerts.length}, odds alerts: ${(state.oddsAlerts || []).length}`)
}

console.log('PolyGlance watcher (Node fallback) jalan — polling 60 detik. Ctrl+C untuk berhenti.')
await tick()
setInterval(() => { void tick() }, 60000)
