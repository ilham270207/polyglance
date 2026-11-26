// PolyGlance watcher — Cloudflare Worker (TARGET UTAMA).
// Cron trigger tiap 1 menit: cek harga CoinGecko -> kirim alert yang crossing
// -> proses perintah bot via getUpdates. Webhook Telegram opsional (POST /webhook).
// Token bot HANYA sebagai Worker secret (wrangler secret put POLYGLANCE_BOT_TOKEN).
// State (offset, alerts, harga terakhir) di KV binding ALERTS_KV.
// Deploy: lihat watcher/README.md. JANGAN commit token ke file mana pun.

import {
  fmtUsd,
  parseBotCommand,
  checkAlertCrossings,
  formatOddsTop,
  parseCoinGeckoPrices,
  parseCoinbaseSpot,
  HELP_TEXT,
} from './core.mjs'

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd'
const COINBASE_BTC_URL = 'https://api.coinbase.com/v2/prices/BTC-USD/spot'
const COINBASE_ETH_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot'
const GAMMA_URL =
  'https://gamma-api.polymarket.com/markets?limit=100&active=true&closed=false&order=volume24hr&ascending=false'
const STATE_KEY = 'polyglance-state-v1'

const tg = (token) => `https://api.telegram.org/bot${token}`

function emptyState() {
  return { offset: 0, chats: [], alerts: [], lastPrices: null, lastTick: null, priceSource: null, priceError: null }
}

async function loadState(kv) {
  try {
    const raw = await kv.get(STATE_KEY)
    if (!raw) return emptyState()
    const s = JSON.parse(raw)
    return { ...emptyState(), ...s }
  } catch {
    return emptyState()
  }
}

async function saveState(kv, state) {
  await kv.put(STATE_KEY, JSON.stringify(state))
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
      const n = state.alerts.filter((a) => a.chatId === chatId).length
      await sendMessage(
        token,
        chatId,
        `Watcher alive. Last check: ${state.lastTick || 'never'}.\n` +
          `Your alerts: ${n}. BTC ${state.lastPrices ? fmtUsd(state.lastPrices.btc) : '?'}, ` +
          `ETH ${state.lastPrices ? fmtUsd(state.lastPrices.eth) : '?'}.`,
      )
      return
    }
    case 'price': {
      if (!state.lastPrices) {
        await sendMessage(token, chatId, 'No price yet — try again in a minute.')
        return
      }
      await sendMessage(
        token,
        chatId,
        `BTC ${fmtUsd(state.lastPrices.btc)}\nETH ${fmtUsd(state.lastPrices.eth)}`,
      )
      return
    }
    case 'odds': {
      try {
        const res = await fetch(GAMMA_URL)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const arr = Array.isArray(data) ? data : data?.markets ?? []
        const lines = formatOddsTop(arr, 3)
        await sendMessage(token, chatId, lines.length ? 'Top Polymarket crypto odds:\n' + lines.join('\n') : 'No odds right now.')
      } catch {
        await sendMessage(token, chatId, 'Could not fetch odds right now.')
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
        token,
        chatId,
        `Alert set: ${parsed.coin} ${parsed.direction} ${fmtUsd(parsed.price)}` +
          (typeof cur === 'number' ? ` (now ${fmtUsd(cur)})` : '') +
          `. I will message you when it crosses.`,
      )
      return
    }
    case 'list': {
      const mine = state.alerts
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => a.chatId === chatId)
      if (mine.length === 0) {
        await sendMessage(token, chatId, 'No alerts yet. Use /alert btc above 58000')
        return
      }
      const lines = mine.map(({ a, i }) => `${i + 1}. ${a.coin} ${a.direction} ${fmtUsd(a.price)}${a.fired ? ' (fired)' : ''}`)
      await sendMessage(token, chatId, 'Your alerts:\n' + lines.join('\n'))
      return
    }
    case 'remove': {
      const mine = state.alerts
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => a.chatId === chatId)
      const target = mine[parsed.index - 1]
      if (!target) {
        await sendMessage(token, chatId, `No alert #${parsed.index}. Use /list to see yours.`)
        return
      }
      const removed = state.alerts[target.i]
      state.alerts.splice(target.i, 1)
      await sendMessage(token, chatId, `Removed: ${removed.coin} ${removed.direction} ${fmtUsd(removed.price)}`)
      return
    }
  }
}

async function handleUpdate(token, state, update) {
  const msg = update?.message
  if (!msg || typeof msg.text !== 'string') return
  const parsed = parseBotCommand(msg.text)
  if (!parsed) {
    await sendMessage(token, msg.chat.id, 'Unknown command. Try /help.')
    return
  }
  await handleCommand(token, state, msg.chat.id, parsed)
}

/** Satu tick cron: harga -> alert crossing -> perintah bot. */
async function tick(env) {
  const token = env.POLYGLANCE_BOT_TOKEN
  if (!token) throw new Error('POLYGLANCE_BOT_TOKEN secret not set')
  const kv = env.ALERTS_KV
  const state = await loadState(kv)

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

  // 2. Perintah bot (polling getUpdates)
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

  state.lastTick = new Date().toISOString()
  await saveState(kv, state)
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
        const state = await loadState(env.ALERTS_KV)
        return Response.json({
          ok: true,
          lastTick: state.lastTick,
          alerts: state.alerts.length,
          chats: state.chats.length,
          btc: state.lastPrices?.btc ?? null,
          eth: state.lastPrices?.eth ?? null,
          priceSource: state.priceSource ?? null,
          priceError: state.priceError ?? null,
        })
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 500 })
      }
    }
    if (request.method === 'POST' && url.pathname === '/webhook') {
      // Mode webhook (opsional): set via setWebhook ke <worker>/webhook,
      // lalu cron tidak perlu polling getUpdates.
      try {
        const token = env.POLYGLANCE_BOT_TOKEN
        if (!token) return Response.json({ ok: false, error: 'no token' }, { status: 500 })
        const update = await request.json()
        const state = await loadState(env.ALERTS_KV)
        await handleUpdate(token, state, update)
        await saveState(env.ALERTS_KV, state)
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
      usage: 'GET /health — status; POST /webhook — Telegram webhook (optional); POST /stt — STT fallback proxy (multipart file=WAV, needs GROQ_API_KEY secret)',
    })
  },
}
