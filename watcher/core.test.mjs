// Tes logika watcher (core.mjs) — tanpa token, tanpa network.
// Jalankan: node watcher/core.test.mjs
import {
  fmtUsd,
  parseBotCommand,
  checkAlertCrossings,
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

console.log(`\nwatcher core: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
