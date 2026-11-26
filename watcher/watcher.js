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
  parseBotCommand,
  checkAlertCrossings,
  formatOddsTop,
  parseCoinGeckoPrices,
  parseCoinbaseSpot,
  HELP_TEXT,
} from './core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_FILE = join(HERE, 'alerts.json')
const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd'
const COINBASE_BTC_URL = 'https://api.coinbase.com/v2/prices/BTC-USD/spot'
const COINBASE_ETH_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot'
const GAMMA_URL =
  'https://gamma-api.polymarket.com/markets?limit=100&active=true&closed=false&order=volume24hr&ascending=false'

const TOKEN = process.env.POLYGLANCE_BOT_TOKEN
if (!TOKEN) {
  console.error('POLYGLANCE_BOT_TOKEN belum diset. Jalankan:\n  export POLYGLANCE_BOT_TOKEN=<token dari @BotFather>')
  process.exit(1)
}
const tg = `https://api.telegram.org/bot${TOKEN}`

function emptyState() {
  return { offset: 0, chats: [], alerts: [], lastPrices: null, lastTick: null }
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
      const n = state.alerts.filter((a) => a.chatId === chatId).length
      await sendMessage(
        chatId,
        `Watcher alive. Last check: ${state.lastTick || 'never'}.\n` +
          `Your alerts: ${n}. BTC ${state.lastPrices ? fmtUsd(state.lastPrices.btc) : '?'}, ` +
          `ETH ${state.lastPrices ? fmtUsd(state.lastPrices.eth) : '?'}.`,
      )
      return
    }
    case 'price': {
      if (!state.lastPrices) {
        await sendMessage(chatId, 'No price yet — try again in a minute.')
        return
      }
      await sendMessage(chatId, `BTC ${fmtUsd(state.lastPrices.btc)}\nETH ${fmtUsd(state.lastPrices.eth)}`)
      return
    }
    case 'odds': {
      try {
        const res = await fetch(GAMMA_URL)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const arr = Array.isArray(data) ? data : data?.markets ?? []
        const lines = formatOddsTop(arr, 3)
        await sendMessage(chatId, lines.length ? 'Top Polymarket crypto odds:\n' + lines.join('\n') : 'No odds right now.')
      } catch {
        await sendMessage(chatId, 'Could not fetch odds right now.')
      }
      return
    }
    case 'alert': {
      state.alerts.push({
        chatId,
        coin: parsed.coin,
        direction: parsed.direction,
        price: parsed.price,
        fired: false,
        createdAt: now,
      })
      const cur = state.lastPrices?.[parsed.coin.toLowerCase()]
      await sendMessage(
        chatId,
        `Alert set: ${parsed.coin} ${parsed.direction} ${fmtUsd(parsed.price)}` +
          (typeof cur === 'number' ? ` (now ${fmtUsd(cur)})` : '') +
          `. I will message you when it crosses.`,
      )
      return
    }
    case 'list': {
      const mine = state.alerts.map((a, i) => ({ a, i })).filter(({ a }) => a.chatId === chatId)
      if (mine.length === 0) {
        await sendMessage(chatId, 'No alerts yet. Use /alert btc above 58000')
        return
      }
      const lines = mine.map(({ a, i }) => `${i + 1}. ${a.coin} ${a.direction} ${fmtUsd(a.price)}${a.fired ? ' (fired)' : ''}`)
      await sendMessage(chatId, 'Your alerts:\n' + lines.join('\n'))
      return
    }
    case 'remove': {
      const mine = state.alerts.map((a, i) => ({ a, i })).filter(({ a }) => a.chatId === chatId)
      const target = mine[parsed.index - 1]
      if (!target) {
        await sendMessage(chatId, `No alert #${parsed.index}. Use /list to see yours.`)
        return
      }
      const removed = state.alerts[target.i]
      state.alerts.splice(target.i, 1)
      await sendMessage(chatId, `Removed: ${removed.coin} ${removed.direction} ${fmtUsd(removed.price)}`)
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
  try {
    const res = await fetch(`${tg}/getUpdates?offset=${state.offset || 0}&timeout=0&limit=50`)
    if (res.ok) {
      const data = await res.json()
      for (const u of data.result || []) {
        state.offset = u.update_id + 1
        const msg = u.message
        if (msg && typeof msg.text === 'string') {
          const parsed = parseBotCommand(msg.text)
          if (!parsed) await sendMessage(msg.chat.id, 'Unknown command. Try /help.')
          else await handleCommand(state, msg.chat.id, parsed)
        }
      }
    }
  } catch (e) {
    console.log('getUpdates failed:', e.message)
  }
  state.lastTick = new Date().toISOString()
  saveState(state)
  console.log(`[${state.lastTick}] tick ok — BTC ${state.lastPrices ? fmtUsd(state.lastPrices.btc) : '?'}, alerts: ${state.alerts.length}`)
}

console.log('PolyGlance watcher (Node fallback) jalan — polling 60 detik. Ctrl+C untuk berhenti.')
await tick()
setInterval(() => { void tick() }, 60000)
