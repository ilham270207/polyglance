// Tes logika watcher (core.mjs) — tanpa token, tanpa network.
// Jalankan: node watcher/core.test.mjs
import {
  fmtUsd,
  fmtPrice,
  fmtVolume,
  parseBotCommand,
  friendlyReply,
  matchDirection,
  checkAlertCrossings,
  checkOddsAlertCrossings,
  findOddsMarket,
  oddsYesByQuestion,
  topOddsMarkets,
  formatOddsRich,
  alertDistance,
  formatAlertsList,
  formatPriceReply,
  formatHealthReply,
  formatAlertSetReply,
  formatOddsAlertSetReply,
  formatRemovedReply,
  parseCoinbaseStats,
  parseCoinbaseCandles,
  aggregateCandles,
  parseFearGreed,
  fmtCountdown,
  candlesSvg,
  sparklineSvg,
  HELP_TEXT,
  parseCoinGeckoPrices,
  parseCoinbaseSpot,
} from './core.mjs'

let pass = 0
let fail = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++ } else { fail++; console.log(`FAIL ${label}\n  got:      ${a}\n  expected: ${e}`) }
}

eq(fmtUsd(58120), '$58,120', 'fmtUsd')
eq(parseCoinGeckoPrices({ bitcoin: { usd: 57123 }, ethereum: { usd: 1987 } }), { btc: 57123, eth: 1987 }, 'coingecko parse')
eq(parseCoinGeckoPrices({}), null, 'coingecko bad payload')

eq(parseCoinbaseSpot({ data: { amount: '60819.355', base: 'BTC', currency: 'USD' } }), 60819.355, 'coinbase spot btc')
eq(parseCoinbaseSpot({ data: { amount: '1699.07', base: 'ETH', currency: 'USD' } }), 1699.07, 'coinbase spot eth')
eq(parseCoinbaseSpot({}), null, 'coinbase bad payload')
eq(parseCoinbaseSpot({ data: { amount: 'abc' } }), null, 'coinbase bukan angka')

eq(parseBotCommand('/start'), { cmd: 'start' }, '/start')
eq(parseBotCommand('/alert btc above 58000'), { cmd: 'alert', coin: 'BTC', direction: 'above', price: 58000 }, '/alert btc above')
eq(parseBotCommand('/alert eth below 1,900'), { cmd: 'alert', coin: 'ETH', direction: 'below', price: 1900 }, '/alert eth below koma')
eq(parseBotCommand('/alert bitcoin over $60000'), { cmd: 'alert', coin: 'BTC', direction: 'above', price: 60000 }, '/alert over $')
eq(parseBotCommand('/alert btc 58000'), null, '/alert tanpa arah -> null')
eq(parseBotCommand('/alert xrp above 5'), null, '/alert coin tidak dikenal -> null')
eq(parseBotCommand('/price'), { cmd: 'price' }, '/price')
eq(parseBotCommand('/odds'), { cmd: 'odds' }, '/odds')
eq(parseBotCommand('/list'), { cmd: 'list' }, '/list')
eq(parseBotCommand('/remove 2'), { cmd: 'remove', index: 2 }, '/remove 2')
eq(parseBotCommand('/remove x'), null, '/remove bukan angka')
eq(parseBotCommand('/help'), { cmd: 'help' }, '/help')
eq(parseBotCommand('/health'), { cmd: 'health' }, '/health')
eq(parseBotCommand('hello'), null, 'bukan perintah')

// crossing: above, sekali per crossing, reset saat kembali ke bawah
const alerts = [{ chatId: 1, coin: 'BTC', direction: 'above', price: 58000, fired: false }]
let r = checkAlertCrossings(alerts, { btc: 57000 }, { btc: 58100 })
eq(r.fired.length, 1, 'crossing above fire')
eq(r.alerts[0].fired, true, 'fired=true setelah fire')
r = checkAlertCrossings(r.alerts, { btc: 58100 }, { btc: 58200 })
eq(r.fired.length, 0, 'tidak spam saat tetap di atas')
r = checkAlertCrossings(r.alerts, { btc: 58200 }, { btc: 57500 })
eq(r.alerts[0].fired, false, 'reset saat kembali ke bawah')
r = checkAlertCrossings(r.alerts, { btc: 57500 }, { btc: 58050 })
eq(r.fired.length, 1, 'fire lagi di crossing berikutnya')
// below
const alerts2 = [{ chatId: 1, coin: 'ETH', direction: 'below', price: 1900, fired: false }]
r = checkAlertCrossings(alerts2, { eth: 1950 }, { eth: 1890 })
eq(r.fired.length, 1, 'crossing below fire')
// tanpa harga sebelumnya: jangan fire
r = checkAlertCrossings(alerts, null, { btc: 59000 })
eq(r.fired.length, 0, 'tanpa prev price jangan fire')

// odds formatting (rich: question lengkap + YES% + volume + link + countdown)
const gamma = [
  { question: 'Will Bitcoin dip to $55,000 in November?', outcomes: '["Yes","No"]', outcomePrices: '["0.48","0.52"]', volume24hr: '1000', slug: 'bitcoin-dip-november', endDate: '2026-12-01T00:00:00Z' },
  { question: 'Will Ethereum reach $2,000 by Dec?', outcomes: '["Yes","No"]', outcomePrices: '["0.07","0.93"]', volume24hr: '900', slug: 'ethereum-2000-dec', endDate: '2026-12-31T00:00:00Z' },
  { question: 'Will the weather be nice?', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', volume24hr: '5000', slug: 'weather-nice', endDate: '2026-11-30T00:00:00Z' },
]
const lines = formatOddsRich(gamma, 2, Date.parse('2026-11-26T12:00:00Z'))
eq(lines.length, 2, 'odds rich top 2')
eq(lines[0].includes('Will Bitcoin dip to $55,000 in November?'), true, 'odds rich question lengkap')
eq(lines[0].includes('YES 48%'), true, 'odds rich yes pct 48')
eq(lines[0].includes('vol $1K'), true, 'odds rich volume')
eq(lines[0].includes('closes in 4d'), true, 'odds rich countdown')
eq(lines[0].includes('polymarket.com/event/bitcoin-dip-november'), true, 'odds rich link')
const top5 = topOddsMarkets(gamma, 5, Date.parse('2026-11-26T12:00:00Z'))
eq(top5.length, 3, 'topOddsMarkets semua (kurang dari 5)')
eq(top5[0].question, 'Will the weather be nice?', 'topOddsMarkets urut volume')

// --- /alertodds (v7) ---
eq(parseBotCommand('/alertodds btc dip above 60'), { cmd: 'alertodds', keyword: 'btc dip', direction: 'above', pct: 60 }, '/alertodds btc dip above 60')
eq(parseBotCommand('/alertodds bitcoin below 40'), { cmd: 'alertodds', keyword: 'bitcoin', direction: 'below', pct: 40 }, '/alertodds bitcoin below 40')
eq(parseBotCommand('/alertodds ethereum reach over 10%'), { cmd: 'alertodds', keyword: 'ethereum reach', direction: 'above', pct: 10 }, '/alertodds over + %')
eq(parseBotCommand('/alertodds btc above'), null, '/alertodds tanpa pct -> null')
eq(parseBotCommand('/alertodds above 60'), null, '/alertodds tanpa keyword -> null')
eq(parseBotCommand('/alertodds btc 60'), null, '/alertodds tanpa arah -> null')
eq(parseBotCommand('/alertodds btc above 0'), null, '/alertodds pct 0 -> null')
eq(parseBotCommand('/alertodds btc above 150'), null, '/alertodds pct >100 -> null')

// findOddsMarket: semua kata keyword harus cocok, pilih volume terbesar
eq(findOddsMarket(gamma, 'bitcoin'), { question: 'Will Bitcoin dip to $55,000 in November?', yes: 48 }, 'findOddsMarket bitcoin')
eq(findOddsMarket(gamma, 'bitcoin dip'), { question: 'Will Bitcoin dip to $55,000 in November?', yes: 48 }, 'findOddsMarket 2 kata')
eq(findOddsMarket(gamma, 'btc dip'), { question: 'Will Bitcoin dip to $55,000 in November?', yes: 48 }, 'findOddsMarket btc = bitcoin (alias)')
eq(findOddsMarket(gamma, 'eth reach'), { question: 'Will Ethereum reach $2,000 by Dec?', yes: 7 }, 'findOddsMarket eth = ethereum (alias)')
eq(findOddsMarket(gamma, 'bitcoin reach'), null, 'findOddsMarket kata tidak cocok -> null')
eq(findOddsMarket(gamma, 'weather'), { question: 'Will the weather be nice?', yes: 50 }, 'findOddsMarket weather')
eq(findOddsMarket([], 'bitcoin'), null, 'findOddsMarket kosong -> null')
eq(oddsYesByQuestion(gamma)['Will Bitcoin dip to $55,000 in November?'], 48, 'oddsYesByQuestion btc 48')
eq(oddsYesByQuestion(gamma)['Will Ethereum reach $2,000 by Dec?'], 7, 'oddsYesByQuestion eth 7')

// crossing odds: above sekali per crossing, reset saat kembali ke bawah
const Q = 'Will Bitcoin dip to $55,000 in November?'
const oa = [{ chatId: 1, keyword: 'btc dip', question: Q, threshold: 60, direction: 'above', fired: false }]
let ro = checkOddsAlertCrossings(oa, { [Q]: 55 }, { [Q]: 61 })
eq(ro.fired.length, 1, 'odds crossing above fire')
eq(ro.alerts[0].fired, true, 'odds fired=true setelah fire')
ro = checkOddsAlertCrossings(ro.alerts, { [Q]: 61 }, { [Q]: 62 })
eq(ro.fired.length, 0, 'odds tidak spam saat tetap di atas')
ro = checkOddsAlertCrossings(ro.alerts, { [Q]: 62 }, { [Q]: 58 })
eq(ro.alerts[0].fired, false, 'odds reset saat kembali ke bawah')
ro = checkOddsAlertCrossings(ro.alerts, { [Q]: 58 }, { [Q]: 60 })
eq(ro.fired.length, 1, 'odds fire lagi di crossing berikutnya')
// below
const oa2 = [{ chatId: 1, keyword: 'bitcoin', question: Q, threshold: 40, direction: 'below', fired: false }]
ro = checkOddsAlertCrossings(oa2, { [Q]: 45 }, { [Q]: 39 })
eq(ro.fired.length, 1, 'odds crossing below fire')
// pasar hilang: jangan fire, jangan reset
ro = checkOddsAlertCrossings(oa, { [Q]: 55 }, {})
eq(ro.fired.length, 0, 'odds pasar hilang jangan fire')
// tanpa prev: jangan fire
ro = checkOddsAlertCrossings(oa, null, { [Q]: 70 })
eq(ro.fired.length, 0, 'odds tanpa prev jangan fire')

// --- fuzzy arah + friendly fallback (tidak ada lagi "Unknown command") ---
eq(matchDirection('about'), 'above', "typo about -> above")
eq(matchDirection('bellow'), 'below', "typo bellow -> below")
eq(matchDirection('abov'), 'above', "typo abov -> above")
eq(matchDirection('abvoe'), 'above', "typo abvoe -> above")
eq(matchDirection('sideways'), null, "arah aneh -> null")
eq(parseBotCommand('/alert btc about 58000'), { cmd: 'alert', coin: 'BTC', direction: 'above', price: 58000 }, "/alert btc about 58000 (typo ilham)")
eq(parseBotCommand('/alert eth bellow 1900'), { cmd: 'alert', coin: 'ETH', direction: 'below', price: 1900 }, "/alert eth bellow 1900")
eq(parseBotCommand('/alert btc abov 58000'), { cmd: 'alert', coin: 'BTC', direction: 'above', price: 58000 }, "/alert btc abov 58000")
eq(parseBotCommand('/alertodds btc dip about 60'), { cmd: 'alertodds', keyword: 'btc dip', direction: 'above', pct: 60 }, "/alertodds about -> above")
eq(parseBotCommand('/alertodds btc dip bellow 40'), { cmd: 'alertodds', keyword: 'btc dip', direction: 'below', pct: 40 }, "/alertodds bellow -> below")
eq(parseBotCommand('/alert btc sideways 58000'), null, "/alert arah aneh tetap null (parser)")
eq(friendlyReply('/alert btc about 58000').parsed, { cmd: 'alert', coin: 'BTC', direction: 'above', price: 58000 }, "friendlyReply typo diterima")
eq(friendlyReply('/alert').usage.includes('Price alerts —'), true, "/alert bare -> description line")
eq(friendlyReply('/alert').usage.includes('Usage: /alert <coin> above|below <price>'), true, "/alert bare -> usage")
eq(friendlyReply('/alert').usage.includes('Example: /alert btc below 60000'), true, "/alert bare -> example")
eq(friendlyReply('/alertodds').usage.includes('Odds alerts —'), true, "/alertodds bare -> description line")
eq(friendlyReply('/alertodds').usage.includes('Usage: /alertodds <keyword> above|below <pct>'), true, "/alertodds bare -> usage")
eq(friendlyReply('/remove').usage.includes('Remove one of your alerts —'), true, "/remove bare -> description line")
eq(friendlyReply('/remove').usage.includes('Usage: /remove <number>'), true, "/remove bare -> usage")
eq(friendlyReply('/remove').usage.includes('See your alerts first with /list'), true, "/remove bare -> check /list first")
eq(friendlyReply('/alert btc sideways 58000').usage.includes("isn't recognized"), true, "/alert bad direction -> correction + usage")
eq(friendlyReply('/alert btc sideways 58000').usage.includes('Usage: /alert'), true, "/alert bad direction still gives usage")
eq(friendlyReply('hello').usage.includes('PolyGlance alerts — live prices'), true, "unknown text -> bot description")
eq(friendlyReply('hello').usage.includes('/price'), true, "unknown text -> command list")
eq(friendlyReply('hello').usage.includes('Unknown command'), false, "unknown text does NOT say Unknown command")
eq(friendlyReply('/foo').usage.includes('Unknown command'), false, "unknown command does NOT say Unknown command")
eq(friendlyReply('/price').parsed, { cmd: 'price' }, "valid command still works")
eq(friendlyReply('/help').parsed, { cmd: 'help' }, "/help still works")
eq(friendlyReply('').usage.includes('/price'), true, "teks kosong -> ringkasan")

// --- rich replies: formatter harga/volume/stats/candles ---
eq(fmtPrice(60928), '$60,928', 'fmtPrice BTC')
eq(fmtPrice(71.095), '$71.09', 'fmtPrice SOL 2 desimal')
eq(fmtPrice(0.056745), '$0.0567', 'fmtPrice DOGE 4 desimal')
eq(fmtPrice(0.96005), '$0.96', 'fmtPrice XRP (nol ekor dibuang)')
eq(fmtVolume(1234567), '$1.2M', 'fmtVolume juta')
eq(fmtVolume(850000), '$850K', 'fmtVolume ribu')
eq(fmtVolume(42), '$42', 'fmtVolume kecil')
const st = parseCoinbaseStats({ open: '59070.95', high: '61526.89', low: '57208.17', last: '60892.74' })
eq(st && Math.round(st.changePct * 10) / 10, 3.1, 'stats changePct +3.1%')
eq(st.high, 61526.89, 'stats high 24h')
eq(st.low, 57208.17, 'stats low 24h')
eq(parseCoinbaseStats({}), null, 'stats payload buruk -> null')
const candles = parseCoinbaseCandles([[1795669200, 60806.26, 60988.03, 60890.77, 60836.23, 103.5], [1795665600, 60679.1, 61042.12, 60692.02, 60890.77, 203.6]])
eq(candles.length, 2, 'candles 2 baris')
eq(candles[0].t < candles[1].t, true, 'candles tertua dulu')
eq(candles[0].low, 60679.1, 'candles urutan kolom [t,low,high,open,close]')
eq(candles[1].close, 60836.23, 'candles close baris terbaru')
eq(parseCoinbaseCandles([]), null, 'candles kosong -> null')
const agg = aggregateCandles([
  { t: 1, low: 10, high: 12, open: 11, close: 12, volume: 1 },
  { t: 2, low: 11, high: 13, open: 12, close: 11, volume: 2 },
  { t: 3, low: 9, high: 14, open: 11, close: 13, volume: 3 },
  { t: 4, low: 12, high: 15, open: 13, close: 14, volume: 4 },
], 4)
eq(agg.length, 1, 'agregasi 4x1h -> 1 candle 4h')
eq(agg[0].open, 11, 'agregasi open = open pertama')
eq(agg[0].close, 14, 'agregasi close = close terakhir')
eq(agg[0].high, 15, 'agregasi high = max')
eq(agg[0].low, 9, 'agregasi low = min')
eq(aggregateCandles([{ t: 1, low: 1, high: 2, open: 1, close: 2, volume: 1 }], 4), null, 'agregasi kurang dari n -> null')
eq(parseFearGreed({ data: [{ value: '11', value_classification: 'Extreme Fear' }] }), { value: 11, label: 'Extreme Fear' }, 'fear & greed parse')
eq(parseFearGreed({ data: [] }), null, 'fear & greed kosong -> null')
eq(fmtCountdown('2026-12-01T00:00:00Z', Date.parse('2026-11-26T12:00:00Z')), 'closes in 4d 12h', 'countdown hari')
eq(fmtCountdown('2026-11-26T15:30:00Z', Date.parse('2026-11-26T12:00:00Z')), 'closes in 3h 30m', 'countdown jam')
eq(fmtCountdown('2026-11-26T12:45:00Z', Date.parse('2026-11-26T12:00:00Z')), 'closes in 45m', 'countdown menit')
eq(fmtCountdown('2026-11-26T11:00:00Z', Date.parse('2026-11-26T12:00:00Z')), 'closed', 'countdown lewat -> closed')
eq(fmtCountdown(null), null, 'countdown tanpa tanggal -> null')
const svg = candlesSvg([{ t: 1795665600, low: 60679, high: 61042, open: 60692, close: 60890 }, { t: 1795669200, low: 60806, high: 60988, open: 60890, close: 60836 }])
eq(svg.includes('<svg'), true, 'candlesSvg ada svg')
eq(svg.includes('#16a34a'), true, 'candlesSvg candle naik hijau')
eq(svg.includes('#dc2626'), true, 'candlesSvg candle turun merah')
eq(svg.includes('<title>O $'), true, 'candlesSvg tooltip OHLC')
eq(svg.includes('26 Nov 04:00 UTC'), true, 'candlesSvg label sumbu kiri ada tanggal')
eq(svg.includes('26 Nov 05:00 UTC'), true, 'candlesSvg label sumbu kanan ada tanggal')
eq(candlesSvg([]), '', 'candlesSvg kosong -> string kosong')
const spark = sparklineSvg([100, 102, 101, 105])
eq(spark.includes('<polyline'), true, 'sparkline ada polyline')
eq(spark.includes('#16a34a'), true, 'sparkline naik hijau')
eq(sparklineSvg([105, 102, 101, 100]).includes('#dc2626'), true, 'sparkline turun merah')
eq(sparklineSvg([100]), '', 'sparkline 1 titik -> kosong')

// --- rich replies: /price /list /health /alert /remove ---
const priceTxt = formatPriceReply([
  { sym: 'BTC', price: 60928, changePct: 3.1 },
  { sym: 'ETH', price: 1699, changePct: -0.8 },
  { sym: 'SOL', price: 71.09, changePct: 3.3 },
  { sym: 'DOGE', price: 0.0567, changePct: 4.0 },
  { sym: 'XRP', price: 0.96, changePct: 4.2 },
], 'Coinbase', '12:40 UTC')
eq(priceTxt.includes('BTC $60,928 (+3.1% 24h)'), true, '/price BTC + change')
eq(priceTxt.includes('SOL $71.09 (+3.3% 24h)'), true, '/price SOL')
eq(priceTxt.includes('DOGE $0.0567 (+4.0% 24h)'), true, '/price DOGE')
eq(priceTxt.includes('Live prices (Coinbase, 12:40 UTC)'), true, '/price header sumber + jam')
eq(formatPriceReply([], 'Coinbase', '12:40 UTC').includes('No prices'), true, '/price kosong -> pesan')
const healthTxt = formatHealthReply({ lastTick: '2026-11-26T05:37:17.358Z', lastPrices: { btc: 60928, eth: 1699 }, priceSource: 'coinbase', yourPrice: 1, yourOdds: 0, chats: 1, webhookActive: true })
eq(healthTxt.includes('Watcher alive.'), true, '/health alive')
eq(healthTxt.includes('BTC $60,928 · ETH $1,699 (coinbase)'), true, '/health harga + sumber')
eq(healthTxt.includes('Your alerts: 1 price, 0 odds · Chats: 1'), true, '/health jumlah alert + chats')
eq(healthTxt.includes('Webhook: online'), true, '/health webhook online')
eq(formatHealthReply({ lastTick: null, lastPrices: null, priceSource: null, yourPrice: 0, yourOdds: 0, chats: 0, webhookActive: false }).includes('Webhook: off (polling)'), true, '/health webhook off')
const listTxt = formatAlertsList(
  [{ chatId: 999, coin: 'BTC', direction: 'below', price: 60000, fired: false }],
  [{ chatId: 999, keyword: 'btc dip', question: 'Will Bitcoin dip to $55,000 in November?', threshold: 60, direction: 'above', fired: false, lastYes: 47 }],
  999, { btc: 60969, eth: 1700 }, null,
)
eq(listTxt.includes('Your alerts (2):'), true, '/list header jumlah')
eq(listTxt.includes('1. BTC below $60,000 — now $60,969 · $969 above the $60,000 threshold · WAITING'), true, '/list price + jarak')
eq(listTxt.includes('2. ODDS "Will Bitcoin dip to $55,000 in November?" YES above 60% — now 47% · 13 pts below the 60% threshold · WAITING'), true, '/list odds + jarak')
eq(listTxt.includes('Remove one with /remove <number>'), true, '/list footer remove')
eq(formatAlertsList([], [], 999, null, null).includes('No alerts yet'), true, '/list kosong')
eq(alertDistance({ coin: 'BTC', direction: 'below', price: 60000 }, 60969), '$969 above the $60,000 threshold', 'alertDistance price')
eq(alertDistance({ threshold: 60 }, 47), '13 pts below the 60% threshold', 'alertDistance odds')
eq(formatAlertSetReply({ coin: 'BTC', direction: 'below', price: 60000, fired: false }, 60969).includes('Alert set: BTC below $60,000\nNow: BTC $60,969 · WAITING · $969 above the $60,000 threshold\nI\'ll ping you when BTC crosses below $60,000.'), true, 'konfirmasi /alert kaya')
eq(formatOddsAlertSetReply({ question: 'Will Bitcoin dip to $55,000 in November?', threshold: 60, direction: 'above', fired: false }, 47).includes('Odds alert set: "Will Bitcoin dip to $55,000 in November?" YES above 60%\nNow: YES 47% · WAITING · 13 pts below the 60% threshold'), true, 'konfirmasi /alertodds kaya')
eq(formatRemovedReply({ coin: 'BTC', direction: 'below', price: 60000 }, 'price', 0), 'Removed: BTC below $60,000\nYou have 0 alerts left. See them with /list.', 'konfirmasi /remove kaya')

// --- /help = guide lengkap (bukan cuma daftar) ---
eq(HELP_TEXT.includes('Quick start:'), true, '/help ada quick start')
eq(HELP_TEXT.includes('/alert btc below 60000'), true, '/help contoh copyable')
eq(HELP_TEXT.includes('Tips:'), true, '/help ada tips')
eq(HELP_TEXT.includes('Open PolyGlance'), true, '/help sebut Mini App')
eq(HELP_TEXT.includes('Build: dorahacks.io/build/51900'), true, '/help ada link Build')
eq(HELP_TEXT.includes('github'), false, '/help TIDAK ada link repo')

console.log(`\nwatcher core: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
