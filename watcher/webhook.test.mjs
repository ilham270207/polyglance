import { parseBotCommand } from './core.mjs'

// Tes webhook worker.js — fetch Telegram + KV di-mock, tidak ada network asli.
// Jalankan: node watcher/webhook.test.mjs  (dari root repo polyglance)
// worker.js adalah ESM di file .js, jadi tes ini menyalinnya ke tmp dir
// sebagai worker.mjs sebelum di-import. Tidak butuh token asli.
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'webhook-test-'))
copyFileSync(join(HERE, 'worker.js'), join(tmp, 'worker.mjs'))
copyFileSync(join(HERE, 'core.mjs'), join(tmp, 'core.mjs'))
const worker = (await import(pathToFileURL(join(tmp, 'worker.mjs')).href)).default

const WEBHOOK_URL = 'https://polyglance-watcher.danham322.workers.dev/webhook'

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${extra}`) }
}

// --- Mock KV (in-memory) — 5 key seperti worker.js ---
const KEY_META = 'polyglance-state-v1'
const KEY_PRICES = 'polyglance-prices-v1'
const KEY_ALERTS = 'polyglance-alerts-v1'
const KEY_WEBHOOK = 'polyglance-webhook-v1'
const KEY_LIVE = 'polyglance-liveprice-v1'
function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null },
    async put(k, v) { store.set(k, v) },
  }
}
// Pecah satu objek state gabungan ke 5 key (seperti yang dilakukan worker).
function seedState(kv, state) {
  kv.store.set(KEY_META, JSON.stringify({ offset: state.offset, chats: state.chats, processedUpdateIds: state.processedUpdateIds || [] }))
  kv.store.set(KEY_PRICES, JSON.stringify({ lastPrices: state.lastPrices, lastTick: state.lastTick, priceSource: state.priceSource, priceError: state.priceError, lastOdds: state.lastOdds }))
  kv.store.set(KEY_ALERTS, JSON.stringify({ alerts: state.alerts, oddsAlerts: state.oddsAlerts || [] }))
  kv.store.set(KEY_LIVE, JSON.stringify({ messages: state.liveMessages || [] }))
  if (state.webhook) kv.store.set(KEY_WEBHOOK, JSON.stringify(state.webhook))
}
// Seed blob LEGACY saja (v1, semua di KEY_META) — untuk tes migrasi.
function seedLegacy(kv, legacy) {
  kv.store.set(KEY_META, JSON.stringify(legacy))
}
function stateOf(kv) {
  const read = (k) => { const v = kv.store.get(k); return v ? JSON.parse(v) : {} }
  return { ...read(KEY_META), ...read(KEY_PRICES), ...read(KEY_ALERTS), webhook: kv.store.has(KEY_WEBHOOK) ? JSON.parse(kv.store.get(KEY_WEBHOOK)) : null, liveMessages: kv.store.has(KEY_LIVE) ? (JSON.parse(kv.store.get(KEY_LIVE)).messages || []) : [] }
}
const BASE_STATE = {
  offset: 0, chats: [999], alerts: [{ chatId: 999, coin: 'BTC', direction: 'below', price: 60000, fired: false, createdAt: 'x' }],
  oddsAlerts: [], lastOdds: null, lastPrices: { btc: 60000, eth: 1700 }, lastTick: '2026-11-26T05:20:00.000Z',
  priceSource: 'coinbase', priceError: 'coingecko 403', webhook: null, processedUpdateIds: [],
}

// --- Mock fetch Telegram + harga ---
const calls = []
let webhookInfoUrl = WEBHOOK_URL // bisa diubah per tes (simulasi webhook dihapus)
let gammaMarkets = [] // bisa diisi per tes
// Kontrol kegagalan mock untuk tes %24h + live-edit (di-reset tiap tes yang memakai)
const failStatsAlways = new Set() // stats koin ini selalu 429
const failStatsOnce = new Set() // stats koin ini 429 di panggilan pertama saja (uji retry)
const statsCalls = {} // hitung panggilan stats per koin
const failCandlesAlways = new Set() // candles koin ini selalu 429
let editMode = 'ok' // 'ok' | 'not_found' — mode balasan /editMessageText
let nextMsgId = 1 // message_id sendMessage mock (naik tiap kirim)
const storedProfile = { short: null, desc: null, commands: null, menuButton: null }
function jres(obj, ok = true, status = 200) {
  return { ok, status, json: async () => obj }
}
// Harga mock per koin (spot + stats 24 jam) — mirip harga live 26 Nov siang.
const MOCK_SPOT = { BTC: '60928.00', ETH: '1699.00', SOL: '71.09', DOGE: '0.0567', XRP: '0.96' }
const MOCK_STATS = {
  BTC: { open: '59070.95', high: '61526.89', low: '57208.17', last: '60892.74' },
  ETH: { open: '1654.92', high: '1728.32', low: '1606.35', last: '1697.31' },
  SOL: { open: '68.64', high: '71.83', low: '65.73', last: '71.11' },
  DOGE: { open: '0.05459', high: '0.05716', low: '0.05213', last: '0.05676' },
  XRP: { open: '0.9158', high: '0.9627', low: '0.8877', last: '0.9603' },
}
// 24 candle 1 jam: [time, low, high, open, close, volume] — terbaru dulu, harga naik pelan.
// 96 baris supaya agregasi 4h (4 x 1h) menghasilkan 24 candle 4h.
function mockCandles(sym) {
  const base = parseFloat(MOCK_SPOT[sym])
  const rows = []
  const t0 = 1795669200
  for (let i = 0; i < 96; i++) {
    const drift = 1 - 0.02 + (i / 96) * 0.03 // -2% -> +1% selama 96 jam
    const open = base * drift
    const close = base * (drift + 0.002)
    rows.push([t0 - i * 3600, open * 0.998, close * 1.002, open, close, 100 + i])
  }
  return rows
}
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  calls.push({ url: u, method: opts.method || 'GET', body: opts.body || null })
  if (u.includes('/sendMessage')) return jres({ ok: true, result: { message_id: nextMsgId++ } })
  if (u.includes('/editMessageText')) {
    if (editMode === 'not_found') return jres({ ok: false, description: 'Bad Request: message to edit not found' }, false, 400)
    return jres({ ok: true, result: true })
  }
  if (u.includes('/setWebhook')) return jres({ ok: true, result: true, description: 'Webhook was set' })
  if (u.includes('/getWebhookInfo')) return jres({ ok: true, result: { url: webhookInfoUrl, has_custom_certificate: false, pending_update_count: 0 } })
  if (u.includes('/getUpdates')) return jres({ ok: true, result: [] })
  if (u.includes('/setMyShortDescription')) { storedProfile.short = JSON.parse(opts.body).short_description; return jres({ ok: true, result: true }) }
  if (u.includes('/setMyDescription')) { storedProfile.desc = JSON.parse(opts.body).description; return jres({ ok: true, result: true }) }
  if (u.includes('/setMyCommands')) { storedProfile.commands = JSON.parse(opts.body).commands; return jres({ ok: true, result: true }) }
  if (u.includes('/setChatMenuButton')) { storedProfile.menuButton = JSON.parse(opts.body).menu_button; return jres({ ok: true, result: true }) }
  if (u.includes('/getMyShortDescription')) return jres({ ok: true, result: { short_description: storedProfile.short } })
  if (u.includes('/getMyDescription')) return jres({ ok: true, result: { description: storedProfile.desc } })
  if (u.includes('/getMyCommands')) return jres({ ok: true, result: storedProfile.commands })
  if (u.includes('/getChatMenuButton')) return jres({ ok: true, result: storedProfile.menuButton })
  if (u.includes('api.coingecko.com')) return jres({ bitcoin: { usd: 61000 }, ethereum: { usd: 1700 } })
  if (u.includes('api.exchange.coinbase.com') && u.includes('/candles')) {
    const sym = (u.match(/products\/([A-Z]+)-USD\/candles/) || [])[1]
    if (failCandlesAlways.has(sym)) return jres({ message: 'rate limited' }, false, 429)
    return jres(MOCK_SPOT[sym] ? mockCandles(sym) : [])
  }
  if (u.includes('api.exchange.coinbase.com') && u.includes('/stats')) {
    const sym = (u.match(/products\/([A-Z]+)-USD\/stats/) || [])[1]
    statsCalls[sym] = (statsCalls[sym] || 0) + 1
    if (failStatsAlways.has(sym)) return jres({ message: 'rate limited' }, false, 429)
    if (failStatsOnce.has(sym) && statsCalls[sym] === 1) return jres({ message: 'rate limited' }, false, 429)
    return jres(MOCK_STATS[sym] || {})
  }
  if (u.includes('api.coinbase.com')) {
    const sym = (u.match(/prices\/([A-Z]+)-USD\/spot/) || [])[1]
    return jres({ data: { amount: MOCK_SPOT[sym] || '61000.00' } })
  }
  if (u.includes('api.alternative.me/fng')) return jres({ data: [{ value: '11', value_classification: 'Extreme Fear', timestamp: '1795651200', time_until_update: '65812' }] })
  if (u.includes('gamma-api.polymarket.com')) return jres(gammaMarkets)
  return jres({}, false, 404)
}

function makeCtx() {
  const promises = []
  return { promises, waitUntil(p) { promises.push(p) }, async drain() { await Promise.all(promises); promises.length = 0 } }
}
const env = (kv) => ({ POLYGLANCE_BOT_TOKEN: 'FAKE_TOKEN', GROQ_API_KEY: 'FAKE_GROQ', ALERTS_KV: kv })
const BASE = 'https://polyglance-watcher.danham322.workers.dev'

// 1. POST /webhook /price -> 200 cepat, balasan kaya setelah waitUntil
console.log('1. webhook /price')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE })
  const ctx = makeCtx()
  const req = new Request(`${BASE}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: 1001, message: { chat: { id: 999 }, text: '/price' } }) })
  const res = await worker.fetch(req, env(kv), ctx)
  check('status 200', res.status === 200)
  check('belum ada sendMessage sebelum drain', !calls.some((c) => c.url.includes('/sendMessage')))
  await ctx.drain()
  const sent = calls.filter((c) => c.url.includes('/sendMessage'))
  check('1x sendMessage', sent.length === 1, JSON.stringify(sent.length))
  const body = JSON.parse(sent[0].body)
  check('chat benar', body.chat_id === 999)
  check('header sumber + jam', body.text.includes('Live prices (Coinbase,'), JSON.stringify(body.text))
  check('5 koin tampil', ['BTC $60,928', 'ETH $1,699', 'SOL $71.09', 'DOGE $0.0567', 'XRP $0.96'].every((s) => body.text.includes(s)), JSON.stringify(body.text))
  check('perubahan 24 jam tampil', body.text.includes('(+3.1% 24h)') && body.text.includes('(+4.9% 24h)'), JSON.stringify(body.text))
  check('SOL + DOGE %24h tampil (bug 13:16 WIB)', body.text.includes('SOL $71.09 (+3.6% 24h)') && body.text.includes('DOGE $0.0567 (+4.0% 24h)'), JSON.stringify(body.text))
  check('footer live ada', body.text.includes('updates every 60s for 30 min') && body.text.includes('send /price again'), JSON.stringify(body.text))
  check('update_id tercatat', stateOf(kv).processedUpdateIds.includes(1001))
}

// 2. Duplikat update_id -> diabaikan
console.log('2. webhook dedupe')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE, processedUpdateIds: [1001] })
  const ctx = makeCtx()
  const before = calls.filter((c) => c.url.includes('/sendMessage')).length
  const req = new Request(`${BASE}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: 1001, message: { chat: { id: 999 }, text: '/price' } }) })
  const res = await worker.fetch(req, env(kv), ctx)
  check('status 200', res.status === 200)
  await ctx.drain()
  const after = calls.filter((c) => c.url.includes('/sendMessage')).length
  check('tidak ada sendMessage kedua', after === before)
}

// 3. POST /webhook /alert -> alert tersimpan di KV
console.log('3. webhook /alert menyimpan state')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE })
  const ctx = makeCtx()
  const req = new Request(`${BASE}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: 1002, message: { chat: { id: 999 }, text: '/alert eth above 1800' } }) })
  await worker.fetch(req, env(kv), ctx)
  await ctx.drain()
  const st = stateOf(kv)
  check('alert baru tersimpan', st.alerts.length === 2 && st.alerts[1].coin === 'ETH' && st.alerts[1].price === 1800, JSON.stringify(st.alerts))
  const sent = calls.filter((c) => c.url.includes('/sendMessage'))
  const last = JSON.parse(sent[sent.length - 1].body)
  check('balasan konfirmasi', last.text.startsWith('Alert set: ETH above $1,800'), JSON.stringify(last.text))
}

// 4. GET /setwebhook -> pasang URL tetap, simpan flag aktif
console.log('4. /setwebhook')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE })
  webhookInfoUrl = WEBHOOK_URL
  const res = await worker.fetch(new Request(`${BASE}/setwebhook`), env(kv), makeCtx())
  const data = await res.json()
  check('status 200', res.status === 200)
  check('setWebhook dipanggil dgn URL tetap', calls.some((c) => c.url.includes('/setWebhook') && JSON.parse(c.body).url === WEBHOOK_URL))
  check('drop_pending_updates false', calls.some((c) => c.url.includes('/setWebhook') && JSON.parse(c.body).drop_pending_updates === false))
  check('webhookInfo url benar', data.webhookInfo?.url === WEBHOOK_URL)
  check('flag tersimpan aktif', stateOf(kv).webhook?.active === true && stateOf(kv).webhook?.url === WEBHOOK_URL, JSON.stringify(stateOf(kv).webhook))
}

// 5. Tick saat webhook aktif -> getUpdates TIDAK dipanggil, harga tetap dicek
console.log('5. tick webhook aktif: skip polling, harga tetap jalan')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE, webhook: { active: true, url: WEBHOOK_URL, setAt: new Date().toISOString(), checkedAt: new Date().toISOString(), pending: 0 } })
  const ctx = makeCtx()
  const nBefore = calls.length
  await worker.scheduled({}, env(kv), ctx)
  await ctx.drain()
  const tickCalls = calls.slice(nBefore)
  check('getUpdates TIDAK dipanggil', !tickCalls.some((c) => c.url.includes('/getUpdates')))
  check('coingecko tetap dicek', tickCalls.some((c) => c.url.includes('api.coingecko.com')))
  const st = stateOf(kv)
  check('harga ter-update', st.lastPrices?.btc === 61000 && st.lastPrices?.eth === 1700, JSON.stringify(st.lastPrices))
  check('lastTick ter-update', typeof st.lastTick === 'string' && st.lastTick > '2026-11-26T05:20:00.000Z')
  check('alert BTC utuh', st.alerts.length === 1 && st.alerts[0].price === 60000)
}

// 6. Tick saat webhook tidak aktif -> polling jalan seperti dulu
console.log('6. tick webhook mati: polling jalan')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE, webhook: null })
  webhookInfoUrl = '' // Telegram memang tidak memasang webhook -> tetap polling
  const ctx = makeCtx()
  const nBefore = calls.length
  await worker.scheduled({}, env(kv), ctx)
  await ctx.drain()
  const tickCalls = calls.slice(nBefore)
  check('getUpdates dipanggil', tickCalls.some((c) => c.url.includes('/getUpdates')))
  webhookInfoUrl = WEBHOOK_URL
}

// 7. Self-heal: webhook aktif tapi getWebhookInfo bilang url kosong -> kembali ke polling
console.log('7. tick self-heal webhook terhapus')
{
  const kv = makeKv()
  seedState(kv, {
    ...BASE_STATE,
    webhook: { active: true, url: WEBHOOK_URL, setAt: '2026-11-26T00:00:00.000Z', checkedAt: '2026-11-26T00:00:00.000Z', pending: 0 },
  })
  webhookInfoUrl = '' // simulasi webhook dihapus dari luar
  const ctx = makeCtx()
  const nBefore = calls.length
  await worker.scheduled({}, env(kv), ctx)
  await ctx.drain()
  const tickCalls = calls.slice(nBefore)
  check('getWebhookInfo dicek', tickCalls.some((c) => c.url.includes('/getWebhookInfo')))
  check('flag jadi tidak aktif', stateOf(kv).webhook?.active === false)
  check('getUpdates dipanggil (fallback polling)', tickCalls.some((c) => c.url.includes('/getUpdates')))
  webhookInfoUrl = WEBHOOK_URL
}

// 8. GET /health menampilkan webhook
console.log('8. /health webhook field')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE, webhook: { active: true, url: WEBHOOK_URL, setAt: 'x', checkedAt: 'x', pending: 0 } })
  const res = await worker.fetch(new Request(`${BASE}/health`), env(kv), makeCtx())
  const data = await res.json()
  check('webhook.active true', data.webhook?.active === true)
  check('webhook.url benar', data.webhook?.url === WEBHOOK_URL)
  check('alerts tetap 1', data.alerts === 1)
}

// 9. GET /webhookinfo live
console.log('9. /webhookinfo')
{
  const kv = makeKv()
  const res = await worker.fetch(new Request(`${BASE}/webhookinfo`), env(kv), makeCtx())
  const data = await res.json()
  check('url live benar', data.webhookInfo?.url === WEBHOOK_URL)
}

// 10. GET /app — dashboard HTML putih: harga 5 koin, candles, F&G, odds, alert (tanpa chatId), TANPA link repo
console.log('10. /app dashboard')
{
  const kv = makeKv()
  seedState(kv, {
    ...BASE_STATE,
    lastPrices: { btc: 60969, eth: 1700 },
    oddsAlerts: [{ chatId: 999, keyword: 'btc dip', question: 'Will Bitcoin dip below $55,000?', threshold: 60, direction: 'above', fired: false, lastYes: 47, createdAt: 'x' }],
  })
  gammaMarkets = [
    { question: 'Will Bitcoin dip below $55,000?', outcomes: '["Yes","No"]', outcomePrices: '["0.47","0.53"]', volume24hr: '1000', slug: 'bitcoin-dip-55000', events: [{ slug: 'bitcoin-dip-event' }], endDate: '2026-12-01T00:00:00Z' },
    { question: 'Will Ethereum reach $2,000?', outcomes: '["Yes","No"]', outcomePrices: '["0.62","0.38"]', volume24hr: '500', slug: 'ethereum-2000', endDate: '2026-12-31T00:00:00Z' },
  ]
  const res = await worker.fetch(new Request(`${BASE}/app`), env(kv), makeCtx())
  const html = await res.text()
  check('status 200 html', res.status === 200 && (res.headers.get('Content-Type') || '').includes('text/html'))
  check('tema putih', html.includes('background:#ffffff'))
  check('harga BTC live tampil', html.includes('BTC') && html.includes('$60,928'))
  check('harga ETH live tampil', html.includes('ETH') && html.includes('$1,699'))
  check('5 koin tampil', ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP'].every((s) => html.includes(`>${s}<`) || html.includes(`>${s} `) || html.includes(s)))
  check('sparkline tampil', html.includes('24h sparkline'))
  check('top movers tampil', html.includes('Top movers'))
  check('Fear & Greed tampil', html.includes('Fear') && html.includes('11'))
  check('candles SVG tampil', html.includes('Candlestick chart') && html.includes('<rect'))
  check('tab koin tampil', html.includes('coin=SOL') && html.includes('coin=XRP'))
  check('tab timeframe tampil', html.includes('tf=4h') && html.includes('tf=1d'))
  check('odds tampil', html.includes('YES 47%') && html.includes('YES 62%'))
  check('odds countdown tampil', html.includes('closes in'))
  check('odds link tampil pendek', html.includes('>View on Polymarket ↗</a>') && !html.includes('>polymarket.com/event/'))
  check('odds link href lengkap tetap', html.includes('href="https://polymarket.com/event/bitcoin-dip-event/bitcoin-dip-55000"'))
  check('odds link TIDAK pakai /event/<market-slug> saja', !html.includes('href="https://polymarket.com/event/bitcoin-dip-55000"'))
  check('price alert tampil + jarak', html.includes('BTC below $60,000') && html.includes('above the $60,000 threshold'))
  check('odds alert tampil', html.includes('YES above 60%'))
  check('link repo TIDAK tampil', !html.includes('github.com') && !html.includes('GitHub repo'))
  check('link Build tampil', html.includes('dorahacks.io/build/51900'))
  check('link video tampil', html.includes('youtube.com/watch?v=sYCcHEM65EI'))
  check('TIDAK ada chatId di HTML', !html.includes('chatId'))
  check('header status tampil', html.includes('Webhook:') && html.includes('Source: Coinbase'))
  gammaMarkets = []
}

// 11. GET /setupbot — pasang profil + menu button, lalu verifikasi
console.log('11. /setupbot profil + menu button')
{
  const kv = makeKv()
  const res = await worker.fetch(new Request(`${BASE}/setupbot`), env(kv), makeCtx())
  const data = await res.json()
  check('status 200', res.status === 200)
  check('setMyShortDescription ok', data.set?.shortDescription?.ok === true)
  check('setMyDescription ok', data.set?.description?.ok === true)
  check('setMyCommands ok', data.set?.commands?.ok === true)
  check('setChatMenuButton ok', data.set?.menuButton?.ok === true)
  check('verify short kembali', data.verify?.shortDescription?.result?.short_description === storedProfile.short)
  check('verify desc kembali', data.verify?.description?.result?.description === storedProfile.desc)
  check('verify commands kembali', JSON.stringify(data.verify?.commands?.result) === JSON.stringify(storedProfile.commands))
  check('verify menu button kembali', data.verify?.menuButton?.result?.type === 'web_app')
  check('short <= 120 karakter', storedProfile.short.length <= 120, `len=${storedProfile.short.length}`)
  check('desc <= 512 karakter', storedProfile.desc.length <= 512, `len=${storedProfile.desc.length}`)
  check('menu button web_app ke /app', storedProfile.menuButton?.web_app?.url === `${BASE}/app` && storedProfile.menuButton?.text === 'Open PolyGlance')
  check('menu button type web_app', storedProfile.menuButton?.type === 'web_app')
  check('deskripsi TIDAK ada link repo', !storedProfile.desc.includes('github') && !storedProfile.desc.includes('Repo:'), storedProfile.desc)
  check('deskripsi tetap ada Build', storedProfile.desc.includes('Build: dorahacks.io/build/51900'))
  // Daftar commands harus sama persis dengan yang didukung core.mjs
  const supported = ['start', 'price', 'odds', 'alert', 'alertodds', 'list', 'remove', 'health', 'help']
  const listed = storedProfile.commands.map((c) => c.command)
  check('9 commands terpasang', listed.length === 9 && supported.every((c) => listed.includes(c)), JSON.stringify(listed))
  for (const c of supported) {
    const sample = { start: '/start', price: '/price', odds: '/odds', alert: '/alert btc above 58000', alertodds: '/alertodds btc dip above 60', list: '/list', remove: '/remove 1', health: '/health', help: '/help' }[c]
    check(`/${c} dikenal core.mjs`, parseBotCommand(sample)?.cmd === c)
  }
  check('semua deskripsi perintah terisi', storedProfile.commands.every((c) => typeof c.description === 'string' && c.description.length > 0 && c.description.length <= 256))
}

// 12. GET /botinfo — baca profil live
console.log('12. /botinfo')
{
  const kv = makeKv()
  const res = await worker.fetch(new Request(`${BASE}/botinfo`), env(kv), makeCtx())
  const data = await res.json()
  check('status 200', res.status === 200)
  check('short description terbaca', data.shortDescription?.result?.short_description === storedProfile.short)
  check('description terbaca', data.description?.result?.description === storedProfile.desc)
  check('commands terbaca', Array.isArray(data.commands?.result) && data.commands.result.length === 9)
  check('menu button terbaca', data.menuButton?.result?.type === 'web_app')
}

// 13. Migrasi: hanya blob legacy (v1) -> key baru terisi, alert + harga + flag utuh
console.log('13. migrasi blob legacy')
{
  const kv = makeKv()
  seedLegacy(kv, {
    offset: 5, chats: [999], processedUpdateIds: [],
    alerts: [{ chatId: 999, coin: 'BTC', direction: 'below', price: 60000, fired: false, createdAt: 'x' }],
    oddsAlerts: [], lastOdds: null, lastPrices: { btc: 60000, eth: 1700 }, lastTick: '2026-11-26T05:20:00.000Z',
    priceSource: 'coinbase', priceError: 'coingecko 403',
    webhook: { active: true, url: WEBHOOK_URL, setAt: 'x', checkedAt: 'x', pending: 0 },
  })
  const res = await worker.fetch(new Request(`${BASE}/health`), env(kv), makeCtx())
  const data = await res.json()
  check('alerts terbaca 1', data.alerts === 1)
  check('harga terbaca', data.btc === 60000 && data.eth === 1700)
  check('webhook flag terbaca aktif', data.webhook?.active === true)
  check('key harga tertulis', kv.store.has(KEY_PRICES))
  check('key alert tertulis', kv.store.has(KEY_ALERTS))
  check('key webhook tertulis', kv.store.has(KEY_WEBHOOK))
}

// 14. REGRESI BUG 26 Nov 12:28 — tick TIDAK BOLEH menimpa flag webhook
// Skenario persis saat bug terjadi: blob lama masih berisi webhook:null,
// tapi key webhook sudah aktif. Tick harus membiarkan flag tetap aktif.
console.log('14. regresi: tick tidak menimpa flag webhook')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE, webhook: { active: true, url: WEBHOOK_URL, setAt: new Date().toISOString(), checkedAt: new Date().toISOString(), pending: 0 } })
  // Blob lama (KEY_META) masih menyimpan field webhook:null peninggalan v1
  const metaRaw = JSON.parse(kv.store.get(KEY_META))
  metaRaw.webhook = null
  kv.store.set(KEY_META, JSON.stringify(metaRaw))
  const flagBefore = kv.store.get(KEY_WEBHOOK)
  const ctx = makeCtx()
  await worker.scheduled({}, env(kv), ctx)
  await ctx.drain()
  check('flag webhook tetap aktif', JSON.parse(kv.store.get(KEY_WEBHOOK)).active === true)
  check('key webhook tidak ditulis ulang tick', kv.store.get(KEY_WEBHOOK) === flagBefore)
  const st = stateOf(kv)
  check('harga tetap ter-update', st.lastPrices?.btc === 61000)
}

// 15. Tick tanpa crossing TIDAK menulis ulang key alert
console.log('15. tick hemat tulis: key alert utuh tanpa crossing')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE })
  const alertsBefore = kv.store.get(KEY_ALERTS)
  const ctx = makeCtx()
  await worker.scheduled({}, env(kv), ctx)
  await ctx.drain()
  check('key alert tidak berubah', kv.store.get(KEY_ALERTS) === alertsBefore)
}

// 16. Webhook /alert hanya menulis meta+alert, TIDAK menyentuh harga
console.log('16. webhook /alert hemat tulis')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE })
  const pricesBefore = kv.store.get(KEY_PRICES)
  const ctx = makeCtx()
  const req = new Request(`${BASE}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: 1003, message: { chat: { id: 999 }, text: '/alert btc above 62000' } }) })
  await worker.fetch(req, env(kv), ctx)
  await ctx.drain()
  check('key harga tidak berubah', kv.store.get(KEY_PRICES) === pricesBefore)
  check('alert baru di key alert', JSON.parse(kv.store.get(KEY_ALERTS)).alerts.length === 2)
}

// 17. Self-heal dua arah: flag hilang tapi webhook masih terpasang -> pulih
console.log('17. self-heal: flag pulih saat webhook masih aktif')
{
  const kv = makeKv()
  // Flag tidak ada (key webhook kosong), tapi Telegram bilang webhook terpasang
  seedState(kv, { ...BASE_STATE, webhook: null })
  webhookInfoUrl = WEBHOOK_URL
  const ctx = makeCtx()
  await worker.scheduled({}, env(kv), ctx)
  await ctx.drain()
  check('flag dipulihkan aktif', kv.store.has(KEY_WEBHOOK) && JSON.parse(kv.store.get(KEY_WEBHOOK)).active === true)
}

// 18. Webhook: perintah telanjang / typo / teks asing -> balasan berguna
console.log('18. webhook friendly fallback')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE })
  const ctx = makeCtx()
  const post = async (id, text) => {
    const req = new Request(`${BASE}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: id, message: { chat: { id: 999 }, text } }) })
    const res = await worker.fetch(req, env(kv), ctx)
    if (res.status !== 200) throw new Error('webhook status ' + res.status)
    await ctx.drain()
    const sent = calls.filter((c) => c.url.includes('/sendMessage'))
    return JSON.parse(sent[sent.length - 1].body).text
  }
  const r1 = await post(2001, '/alertodds')
  check('/alertodds bare -> description + usage', r1.includes('Odds alerts —') && r1.includes('Usage: /alertodds <keyword> above|below <pct>'), JSON.stringify(r1))
  const r2 = await post(2002, '/remove')
  check('/remove bare -> description + usage', r2.includes('Remove one of your alerts —') && r2.includes('Usage: /remove <number>'), JSON.stringify(r2))
  const r3 = await post(2003, 'halo bot')
  check('unknown text -> bot description + list', r3.includes('PolyGlance alerts — live prices') && r3.includes('/price') && r3.includes('/alertodds'), JSON.stringify(r3))
  check('unknown text does NOT say Unknown', !r3.includes('Unknown command'), JSON.stringify(r3))
  const r4 = await post(2004, '/alert btc about 58000')
  check('typo about accepted', r4.includes('Alert set: BTC above $58,000'), JSON.stringify(r4))
  const st = stateOf(kv)
  check('typo alert saved as above', st.alerts.some((a) => a.coin === 'BTC' && a.direction === 'above' && a.price === 58000))
  const r5 = await post(2005, '/alert btc sideways 58000')
  check('bad direction -> correction', r5.includes("isn't recognized") && r5.includes('Usage: /alert'), JSON.stringify(r5))
  const r6 = await post(2006, '/alert')
  check('/alert bare -> description + usage + example', r6.includes('Price alerts —') && r6.includes('Usage: /alert <coin> above|below <price>') && r6.includes('Example: /alert btc below 60000'), JSON.stringify(r6))
}

// 19. Rich replies: /odds top 5, /list + jarak, /alert + /alertodds konfirmasi, /remove
console.log('19. rich replies /odds /list /alert /alertodds /remove')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE })
  const ctx = makeCtx()
  const post = async (id, text) => {
    const req = new Request(`${BASE}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: id, message: { chat: { id: 999 }, text } }) })
    const res = await worker.fetch(req, env(kv), ctx)
    if (res.status !== 200) throw new Error('webhook status ' + res.status)
    await ctx.drain()
    const sent = calls.filter((c) => c.url.includes('/sendMessage'))
    return JSON.parse(sent[sent.length - 1].body).text
  }
  gammaMarkets = [
    { question: 'Will Bitcoin dip to $55,000 in November?', outcomes: '["Yes","No"]', outcomePrices: '["0.48","0.52"]', volume24hr: '1200000', slug: 'bitcoin-dip-november', events: [{ slug: 'bitcoin-price-november' }], endDate: '2026-12-01T00:00:00Z' },
    { question: 'Will Ethereum reach $2,000 by Dec?', outcomes: '["Yes","No"]', outcomePrices: '["0.07","0.93"]', volume24hr: '900000', slug: 'ethereum-2000-dec', endDate: '2026-12-31T00:00:00Z' },
    { question: 'Will Solana reach $100?', outcomes: '["Yes","No"]', outcomePrices: '["0.35","0.65"]', volume24hr: '800000', slug: 'solana-100', endDate: '2026-12-15T00:00:00Z' },
    { question: 'Will Bitcoin hit $70,000?', outcomes: '["Yes","No"]', outcomePrices: '["0.22","0.78"]', volume24hr: '700000', slug: 'bitcoin-70000', endDate: '2026-12-20T00:00:00Z' },
    { question: 'Will XRP reach $1.50?', outcomes: '["Yes","No"]', outcomePrices: '["0.15","0.85"]', volume24hr: '600000', slug: 'xrp-150', endDate: '2026-12-25T00:00:00Z' },
    { question: 'Will Dogecoin reach $0.10?', outcomes: '["Yes","No"]', outcomePrices: '["0.30","0.70"]', volume24hr: '500000', slug: 'doge-010', endDate: '2026-12-28T00:00:00Z' },
  ]
  const o = await post(3001, '/odds')
  check('/odds top 5', o.includes('Top 5 Polymarket crypto odds') && o.includes('Will Bitcoin dip to $55,000 in November?') && o.includes('Will XRP reach $1.50?'), JSON.stringify(o))
  check('/odds volume + countdown + link', o.includes('vol $1.2M') && o.includes('closes in') && o.includes('polymarket.com/event/bitcoin-price-november/bitcoin-dip-november'), JSON.stringify(o))
  check('/odds market ke-6 tidak tampil', !o.includes('Will Dogecoin reach $0.10?'), JSON.stringify(o))
  const a = await post(3002, '/alert eth below 1900')
  check('/alert konfirmasi kaya', a.includes('Alert set: ETH below $1,900') && a.includes('Now: ETH $1,700') && a.includes("I'll ping you when ETH crosses below $1,900"), JSON.stringify(a))
  const ao = await post(3003, '/alertodds btc dip above 60')
  check('/alertodds konfirmasi kaya', ao.includes('Odds alert set: "Will Bitcoin dip to $55,000 in November?" YES above 60%') && ao.includes('Now: YES 48%') && ao.includes("I'll ping you when YES% crosses above 60%"), JSON.stringify(ao))
  const l = await post(3004, '/list')
  check('/list 3 alert + jarak', l.includes('Your alerts (3):') && l.includes('1. BTC below $60,000 — now $60,000') && l.includes('2. ETH below $1,900') && l.includes('3. ODDS "Will Bitcoin dip to $55,000 in November?" YES above 60% — now 48%'), JSON.stringify(l))
  const r = await post(3005, '/remove 2')
  check('/remove sukses kaya', r.includes('Removed: ETH below $1,900') && r.includes('You have 2 alerts left'), JSON.stringify(r))
  const rm = await post(3006, '/remove 9')
  check('/remove nomor tidak ada + tampilkan list', rm.includes('No alert #9') && rm.includes('Your alerts (2):'), JSON.stringify(rm))
  gammaMarkets = []
}

// 20. /health kaya + /help guide
console.log('20. /health kaya + /help guide')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE, webhook: { active: true, url: WEBHOOK_URL, setAt: 'x', checkedAt: 'x', pending: 0 } })
  const ctx = makeCtx()
  const post = async (id, text) => {
    const req = new Request(`${BASE}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: id, message: { chat: { id: 999 }, text } }) })
    const res = await worker.fetch(req, env(kv), ctx)
    if (res.status !== 200) throw new Error('webhook status ' + res.status)
    await ctx.drain()
    const sent = calls.filter((c) => c.url.includes('/sendMessage'))
    return JSON.parse(sent[sent.length - 1].body).text
  }
  const h = await post(4001, '/health')
  check('/health alive + harga + sumber', h.includes('Watcher alive.') && h.includes('BTC $60,000 · ETH $1,700 (coinbase)'), JSON.stringify(h))
  check('/health jumlah + webhook', h.includes('Your alerts: 1 price, 0 odds · Chats: 1') && h.includes('Webhook: online'), JSON.stringify(h))
  const hp = await post(4002, '/help')
  check('/help quick start', hp.includes('Quick start:') && hp.includes('/alert btc below 60000'), JSON.stringify(hp))
  check('/help tips + Mini App', hp.includes('Tips:') && hp.includes('Open PolyGlance'), JSON.stringify(hp))
  check('/help Build, tanpa repo', hp.includes('Build: dorahacks.io/build/51900') && !hp.includes('github'), JSON.stringify(hp))
  const s = await post(4003, '/start')
  check('/start sapaan + guide', s.includes('@polyglance_alerts_bot') && s.includes('Quick start:'), JSON.stringify(s))
}

// 21. /app?coin=SOL&tf=4h — picker koin + timeframe
console.log('21. /app picker coin + timeframe')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE })
  gammaMarkets = []
  const res = await worker.fetch(new Request(`${BASE}/app?coin=SOL&tf=4h`), env(kv), makeCtx())
  const html = await res.text()
  check('status 200', res.status === 200)
  check('judul candle SOL 4h', html.includes('Candles · SOL · 4h'))
  check('tab SOL aktif', html.includes('class="tab active" href="/app?coin=SOL'))
  check('tab 4h aktif', html.includes('class="tab active" href="/app?coin=SOL&amp;tf=4h"'))
  check('candles SOL tampil', html.includes('Candlestick chart'))
  check('OHLC candle terakhir tampil', html.includes('Last 4h candle:'))
  check('refresh pertahankan param', html.includes('content="60;url=/app?coin=SOL&amp;tf=4h"'))
  const res2 = await worker.fetch(new Request(`${BASE}/app?coin=FOO&tf=9x`), env(kv), makeCtx())
  const html2 = await res2.text()
  check('coin/tf tidak valid -> default BTC 1h', html2.includes('Candles · BTC · 1h'))
}

// 22. Webhook /price melacak pesan live di KV + footer
console.log('22. /price melacak pesan live')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE })
  const ctx = makeCtx()
  const req = new Request(`${BASE}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: 5001, message: { chat: { id: 999 }, text: '/price' } }) })
  const res = await worker.fetch(req, env(kv), ctx)
  check('status 200', res.status === 200)
  await ctx.drain()
  const st = stateOf(kv)
  check('1 entri live tersimpan', st.liveMessages.length === 1, JSON.stringify(st.liveMessages))
  check('entri = chat + messageId + sentAt', st.liveMessages[0]?.chatId === 999 && typeof st.liveMessages[0]?.messageId === 'number' && typeof st.liveMessages[0]?.sentAt === 'number', JSON.stringify(st.liveMessages))
}

// 23. Stats gagal sekali -> retry -> %24h tetap ada (bug 13:16 WIB)
console.log('23. stats gagal sekali: retry menyelamatkan %24h')
{
  failStatsOnce.add('SOL')
  statsCalls.SOL = 0
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE })
  const ctx = makeCtx()
  const req = new Request(`${BASE}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: 5002, message: { chat: { id: 999 }, text: '/price' } }) })
  await worker.fetch(req, env(kv), ctx)
  await ctx.drain()
  const sent = calls.filter((c) => c.url.includes('/sendMessage'))
  const last = JSON.parse(sent[sent.length - 1].body)
  check('SOL %24h tetap tampil setelah retry', last.text.includes('SOL $71.09 (+3.6% 24h)'), JSON.stringify(last.text))
  check('stats SOL dipanggil 2x (retry)', statsCalls.SOL === 2, `calls=${statsCalls.SOL}`)
  failStatsOnce.clear()
}

// 24. Stats gagal total -> fallback candle (SOL) + marker — (DOGE)
console.log('24. stats gagal total: fallback candle + marker —')
{
  failStatsAlways.add('SOL')
  failStatsAlways.add('DOGE')
  failCandlesAlways.add('DOGE')
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE })
  const ctx = makeCtx()
  const req = new Request(`${BASE}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: 5003, message: { chat: { id: 999 }, text: '/price' } }) })
  await worker.fetch(req, env(kv), ctx)
  await ctx.drain()
  const sent = calls.filter((c) => c.url.includes('/sendMessage'))
  const last = JSON.parse(sent[sent.length - 1].body)
  check('SOL %24h dari fallback candle', last.text.includes('SOL $71.09 (') && last.text.includes('% 24h)') && !last.text.includes('SOL $71.09 (— 24h)'), JSON.stringify(last.text))
  check('DOGE tampil (— 24h) eksplisit', last.text.includes('DOGE $0.0567 (— 24h)'), JSON.stringify(last.text))
  check('BTC/ETH/XRP %24h tetap ada', ['(+3.1% 24h)', '(+2.6% 24h)', '(+4.9% 24h)'].every((s) => last.text.includes(s)), JSON.stringify(last.text))
  failStatsAlways.clear()
  failCandlesAlways.clear()
}

// 25. Tick edit pesan /price live (masih <30 menit)
console.log('25. tick edit pesan /price live')
{
  const kv = makeKv()
  seedState(kv, {
    ...BASE_STATE,
    webhook: { active: true, url: WEBHOOK_URL, setAt: new Date().toISOString(), checkedAt: new Date().toISOString(), pending: 0 },
    liveMessages: [{ chatId: 999, messageId: 42, sentAt: Date.now() }],
  })
  const ctx = makeCtx()
  const nBefore = calls.length
  await worker.scheduled({}, env(kv), ctx)
  await ctx.drain()
  const tickCalls = calls.slice(nBefore)
  const edits = tickCalls.filter((c) => c.url.includes('/editMessageText'))
  check('1x editMessageText', edits.length === 1, JSON.stringify(edits.length))
  const ebody = JSON.parse(edits[0].body)
  check('edit ke chat + pesan benar', ebody.chat_id === 999 && ebody.message_id === 42, JSON.stringify(ebody))
  check('teks edit = /price live + footer', ebody.text.includes('Live prices (Coinbase,') && ebody.text.includes('updates every 60s for 30 min') && ebody.text.includes('BTC $60,928'), JSON.stringify(ebody.text))
  check('entri live dipertahankan', stateOf(kv).liveMessages.length === 1 && stateOf(kv).liveMessages[0].messageId === 42)
  check('alert BTC utuh', stateOf(kv).alerts.length === 1)
}

// 26. Tick buang entri live kedaluwarsa (>30 menit) tanpa edit
console.log('26. tick buang entri live kedaluwarsa')
{
  const kv = makeKv()
  seedState(kv, {
    ...BASE_STATE,
    webhook: { active: true, url: WEBHOOK_URL, setAt: new Date().toISOString(), checkedAt: new Date().toISOString(), pending: 0 },
    liveMessages: [{ chatId: 999, messageId: 42, sentAt: Date.now() - 31 * 60 * 1000 }],
  })
  const ctx = makeCtx()
  const nBefore = calls.length
  await worker.scheduled({}, env(kv), ctx)
  await ctx.drain()
  const tickCalls = calls.slice(nBefore)
  check('tidak ada editMessageText', !tickCalls.some((c) => c.url.includes('/editMessageText')))
  check('entri dibuang', stateOf(kv).liveMessages.length === 0)
  check('alert BTC utuh', stateOf(kv).alerts.length === 1)
}

// 27. Edit not_found (pesan dihapus) -> entri dibuang, tick tetap jalan
console.log('27. edit not_found -> entri dibuang')
{
  editMode = 'not_found'
  const kv = makeKv()
  seedState(kv, {
    ...BASE_STATE,
    webhook: { active: true, url: WEBHOOK_URL, setAt: new Date().toISOString(), checkedAt: new Date().toISOString(), pending: 0 },
    liveMessages: [{ chatId: 999, messageId: 42, sentAt: Date.now() }],
  })
  const ctx = makeCtx()
  await worker.scheduled({}, env(kv), ctx)
  await ctx.drain()
  check('entri dibuang setelah not_found', stateOf(kv).liveMessages.length === 0)
  check('alert BTC utuh', stateOf(kv).alerts.length === 1)
  check('lastTick tetap jalan', typeof stateOf(kv).lastTick === 'string')
  editMode = 'ok'
}

// 28. /price kedua ganti pesan live lama (satu per chat)
console.log('28. /price kedua ganti pesan live lama')
{
  const kv = makeKv()
  seedState(kv, { ...BASE_STATE })
  const ctx = makeCtx()
  const firstId = nextMsgId
  for (const id of [6001, 6002]) {
    const req = new Request(`${BASE}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: id, message: { chat: { id: 999 }, text: '/price' } }) })
    await worker.fetch(req, env(kv), ctx)
    await ctx.drain()
  }
  const st = stateOf(kv)
  check('satu entri saja', st.liveMessages.length === 1, JSON.stringify(st.liveMessages))
  check('entri = pesan /price kedua', st.liveMessages[0]?.messageId === firstId + 1, JSON.stringify(st.liveMessages))
}

rmSync(tmp, { recursive: true, force: true })
console.log(`\nwebhook test: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
