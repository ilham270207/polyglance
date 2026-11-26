// Tes logika watcher (core.mjs) — tanpa token, tanpa network.
// Jalankan: node watcher/core.test.mjs
import {
  fmtUsd,
  parseBotCommand,
  checkAlertCrossings,
  checkOddsAlertCrossings,
  findOddsMarket,
  oddsYesByQuestion,
  formatOddsTop,
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

// odds formatting
const gamma = [
  { question: 'Will Bitcoin dip to $55,000 in November?', outcomes: '["Yes","No"]', outcomePrices: '["0.48","0.52"]', volume24hr: '1000' },
  { question: 'Will Ethereum reach $2,000 by Dec?', outcomes: '["Yes","No"]', outcomePrices: '["0.07","0.93"]', volume24hr: '900' },
  { question: 'Will the weather be nice?', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', volume24hr: '5000' },
]
const lines = formatOddsTop(gamma, 2)
eq(lines.length, 2, 'odds top 2')
eq(lines[0].includes('YES 48%'), true, 'odds yes pct 48')

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

console.log(`\nwatcher core: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
