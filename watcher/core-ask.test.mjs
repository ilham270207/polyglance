// Tes logika v8.2 (ASK / WHALES / MOOD / Morning Brief / hemat KV) — tanpa token, tanpa network.
// Jalankan: node watcher/core-ask.test.mjs
import {
  parseBotCommand,
  friendlyReply,
  isAskRefusalNeeded,
  ASK_REFUSAL,
  buildAskMessages,
  parseAskAnswer,
  parseWhaleTrades,
  formatWhalesReply,
  formatWhaleUsd,
  computeMoodLevel,
  formatMorningBrief,
  briefDue,
  shouldPersistPrices,
  PRICES_PERSIST_MIN_MS,
  HELP_TEXT,
  FALLBACK_TEXT,
  USAGE_TEXT,
} from './core.mjs'

let pass = 0
let fail = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; }
  else { fail++; console.log(`FAIL ${label}\n  got:      ${a}\n  expected: ${e}`) }
}
function ok(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.log(`FAIL ${label}`) }
}

// --- perintah bot baru ---
eq(parseBotCommand('/ask why is bitcoin down?'), { cmd: 'ask', question: 'why is bitcoin down?' }, '/ask')
eq(parseBotCommand('/ask'), null, '/ask tanpa pertanyaan -> null')
eq(parseBotCommand('/ask hi'), null, '/ask terlalu pendek -> null')
eq(parseBotCommand('/whales'), { cmd: 'whales' }, '/whales')
eq(parseBotCommand('/brief'), { cmd: 'brief' }, '/brief')
eq(parseBotCommand('/ASK WHY IS BITCOIN DOWN'), { cmd: 'ask', question: 'WHY IS BITCOIN DOWN' }, '/ask kapital')
ok(friendlyReply('/ask').usage === USAGE_TEXT.ask, 'friendlyReply /ask tanpa argumen -> usage ask')
ok(friendlyReply('/whales').parsed.cmd === 'whales', 'friendlyReply /whales -> parsed')
ok(friendlyReply('/brief').parsed.cmd === 'brief', 'friendlyReply /brief -> parsed')
ok(HELP_TEXT.includes('/ask'), 'HELP_TEXT ada /ask')
ok(HELP_TEXT.includes('/whales'), 'HELP_TEXT ada /whales')
ok(HELP_TEXT.includes('/brief'), 'HELP_TEXT ada /brief')
ok(FALLBACK_TEXT.includes('/ask'), 'FALLBACK ada /ask')
ok(FALLBACK_TEXT.includes('/whales'), 'FALLBACK ada /whales')

// --- ASK: pre-check penolakan ---
eq(isAskRefusalNeeded('should i buy bitcoin'), true, 'refusal: should i buy')
eq(isAskRefusalNeeded('will bitcoin reach 100k?'), true, 'refusal: will reach')
eq(isAskRefusalNeeded('will btc go to 100k'), true, 'refusal: will go to')
eq(isAskRefusalNeeded('when to buy bitcoin'), true, 'refusal: when to buy')
eq(isAskRefusalNeeded('is now a good time to buy bitcoin'), true, 'refusal: good time to buy')
eq(isAskRefusalNeeded('give me investment advice'), true, 'refusal: advice')
eq(isAskRefusalNeeded('predict bitcoin price'), true, 'refusal: predict')
eq(isAskRefusalNeeded('shall we sell eth'), true, 'refusal: shall we sell')
eq(isAskRefusalNeeded('why is bitcoin down?'), false, 'factual: why down -> lolos')
eq(isAskRefusalNeeded('is bitcoin fear or greed?'), false, 'factual: fear or greed -> lolos')
eq(isAskRefusalNeeded('what is the price of bitcoin'), false, 'factual: price -> lolos')
eq(isAskRefusalNeeded('is bitcoin going up'), false, 'factual: going up -> lolos (LLM jawab dari data)')
eq(isAskRefusalNeeded('should bitcoin be above 60k'), false, 'factual: should + bukan i/we -> lolos')
eq(isAskRefusalNeeded(''), false, 'refusal: kosong -> false')
eq(ASK_REFUSAL, 'I can share live data, not predictions or advice.', 'teks penolakan')

// --- ASK: pesan Groq + parse jawaban ---
const msgs = buildAskMessages('why is bitcoin down?', ['BTC $60,388 (+3.2% 24h)', 'Fear & Greed: 11 (Extreme Fear)'])
eq(msgs.length, 2, 'buildAskMessages 2 pesan')
eq(msgs[0].role, 'system', 'buildAskMessages system')
ok(msgs[0].content.includes('NEVER predict'), 'system prompt larang prediksi')
ok(msgs[0].content.includes('NEVER give financial advice'), 'system prompt larang advice')
ok(msgs[1].content.includes('BTC $60,388'), 'user msg bawa data live')
ok(msgs[1].content.includes('why is bitcoin down?'), 'user msg bawa pertanyaan')
eq(parseAskAnswer('BTC is $60,388, up 3.2% in 24h.\nFear is 11, extreme fear.'), 'BTC is $60,388, up 3.2% in 24h.\nFear is 11, extreme fear.', 'parseAskAnswer 2 baris')
eq(parseAskAnswer('One line.\nTwo lines.\nThree lines.'), 'One line.\nTwo lines.', 'parseAskAnswer potong ke 2 baris')
eq(parseAskAnswer(''), null, 'parseAskAnswer kosong -> null')
eq(parseAskAnswer(null), null, 'parseAskAnswer null -> null')
ok(parseAskAnswer('x'.repeat(150)).length <= 100, 'parseAskAnswer baris <=100')

// --- WHALES: parse + format ---
const NOW = Date.parse('2026-11-27T00:30:00Z')
const trades = [
  { size: 20000, price: 0.62, outcome: 'Yes', title: 'Will Bitcoin dip to $55,000 in November?', name: 'whale123', timestamp: NOW / 1000 - 120, transactionHash: '0xaaa' },
  { size: 5000, price: 0.5, outcome: 'No', title: 'Will Ethereum reach $2,000?', pseudonym: 'anon7', timestamp: NOW / 1000 - 60, transactionHash: '0xbbb' },
  { size: 100, price: 0.5, outcome: 'Yes', title: 'Will Bitcoin dip to $55,000 in November?', name: 'kecil', timestamp: NOW / 1000 - 30, transactionHash: '0xccc' }, // $50 -> di bawah $1.000, dibuang
  { size: 30000, price: 0.5, outcome: 'Yes', title: 'Will the Lakers win tonight?', name: 'sport', timestamp: NOW / 1000 - 10, transactionHash: '0xddd' }, // bukan crypto, dibuang
  { size: 20000, price: 0.62, outcome: 'Yes', title: 'Will Bitcoin dip to $55,000 in November?', name: 'whale123', timestamp: NOW / 1000 - 120, transactionHash: '0xaaa' }, // duplikat tx, dibuang
  { size: 0, price: 0.5, outcome: 'Yes', title: 'Will Bitcoin hit $100k?', name: 'nol', timestamp: NOW / 1000, transactionHash: '0xeee' }, // size 0, dibuang
]
const whales = parseWhaleTrades(trades, NOW)
eq(whales.length, 2, 'parseWhaleTrades: 2 lolos (kecil/bukan-crypto/duplikat/nol dibuang)')
eq(whales[0].question, 'Will Ethereum reach $2,000?', 'whales urut terbaru dulu')
eq(whales[0].usd, 2500, 'whales usd = size x price')
eq(whales[0].pct, 50, 'whales pct = price x 100')
eq(whales[0].outcome, 'NO', 'whales outcome uppercase')
eq(whales[0].trader, 'anon7', 'whales trader dari pseudonym')
eq(whales[0].mins, 1, 'whales mins dari timestamp detik')
eq(whales[1].trader, 'whale123', 'whales trader dari name')
eq(whales[1].mins, 2, 'whales mins 2')
eq(parseWhaleTrades(null, NOW), [], 'parseWhaleTrades null -> []')
eq(parseWhaleTrades([], NOW), [], 'parseWhaleTrades kosong -> []')
// timestamp milidetik juga diterima
const msTrade = parseWhaleTrades([{ size: 2000, price: 0.6, outcome: 'Yes', title: 'Bitcoin above $70k?', name: 'ms', timestamp: NOW - 60000, transactionHash: '0xfff' }], NOW)
eq(msTrade.length, 1, 'whales timestamp ms diterima')
eq(msTrade[0].mins, 1, 'whales mins dari timestamp ms')
eq(formatWhaleUsd(12400), '$12.4K', 'formatWhaleUsd 12.4K')
eq(formatWhaleUsd(1240000), '$1.2M', 'formatWhaleUsd 1.2M')
ok(formatWhalesReply(whales).includes('$2.5K NO'), 'formatWhalesReply isi trade 1')
ok(formatWhalesReply(whales).includes('Will Ethereum reach $2,000?'), 'formatWhalesReply pertanyaan')
eq(formatWhalesReply([]), 'No big crypto trades ($1,000+) in the last few minutes — try again soon.', 'formatWhalesReply kosong')

// --- MOOD: skor (cerminan src/mood.ts) ---
eq(computeMoodLevel({ fng: 11, btcChg: -3.5, fundingAvg: 0.0001 }), 'risk-off', 'mood risk-off')
eq(computeMoodLevel({ fng: 75, btcChg: 4, fundingAvg: 0.002 }), 'euphoric', 'mood euphoric')
eq(computeMoodLevel({ fng: 50, btcChg: 0, fundingAvg: 0 }), 'neutral', 'mood neutral')
eq(computeMoodLevel({ fng: null, btcChg: null, fundingAvg: null }), 'neutral', 'mood tanpa data = neutral')
eq(computeMoodLevel({ fng: 30, btcChg: null, fundingAvg: null }), 'cautious', 'mood cautious')

// --- Morning Brief ---
const brief = formatMorningBrief({
  coins: [{ sym: 'BTC', price: 60388, changePct: 3.2 }, { sym: 'ETH', price: 1696, changePct: -1.1 }],
  fng: { value: 11, label: 'Extreme Fear' },
  topOdds: [{ question: 'Will Bitcoin dip to $55,000 in November?', yes: 48 }],
  dateLabel: 'Fri 27 Nov 2026',
})
ok(brief.includes('Morning brief — Fri 27 Nov 2026:'), 'brief header + tanggal')
ok(brief.includes('BTC $60,388 (+3.2% 24h)'), 'brief harga btc')
ok(brief.includes('ETH $1,696 (-1.1% 24h)'), 'brief harga eth')
ok(brief.includes('Fear & Greed: 11 (Extreme Fear)'), 'brief fng')
ok(brief.includes('Will Bitcoin dip to $55,000 in November? — YES 48%'), 'brief odds')
ok(brief.includes('Mini App'), 'brief footer mini app')
const briefEmpty = formatMorningBrief({ coins: [], fng: null, topOdds: [], dateLabel: 'today' })
ok(briefEmpty.includes('Morning brief — today:'), 'brief kosong tetap ada header')
ok(briefEmpty.includes('Mini App'), 'brief kosong tetap ada footer')

// --- briefDue: hanya jam 01:00 UTC + belum dikirim hari ini ---
eq(briefDue('2026-11-26', Date.parse('2026-11-27T01:05:00Z')), true, 'briefDue: jam 01 UTC + belum kirim -> true')
eq(briefDue('2026-11-27', Date.parse('2026-11-27T01:05:00Z')), false, 'briefDue: sudah kirim hari ini -> false')
eq(briefDue('2026-11-26', Date.parse('2026-11-27T02:00:00Z')), false, 'briefDue: jam 02 UTC -> false')
eq(briefDue('2026-11-26', Date.parse('2026-11-27T00:59:00Z')), false, 'briefDue: jam 00 UTC -> false')
eq(briefDue(null, Date.parse('2026-11-27T01:00:00Z')), true, 'briefDue: belum pernah kirim -> true')
eq(briefDue('', Date.parse('2026-11-27T01:30:00Z')), true, 'briefDue: lastSent kosong -> true')

// --- hemat KV: throttle penulisan key prices ---
eq(PRICES_PERSIST_MIN_MS, 600000, 'throttle 10 menit')
eq(shouldPersistPrices('2026-11-27T00:00:00.000Z', Date.parse('2026-11-27T00:09:59.000Z')), false, 'throttle: 9m59s -> tahan')
eq(shouldPersistPrices('2026-11-27T00:00:00.000Z', Date.parse('2026-11-27T00:10:00.000Z')), true, 'throttle: 10m00s -> tulis')
eq(shouldPersistPrices('2026-11-27T00:00:00.000Z', Date.parse('2026-11-27T01:00:00.000Z')), true, 'throttle: 1 jam -> tulis')
eq(shouldPersistPrices('', Date.parse('2026-11-27T00:00:00.000Z')), true, 'throttle: belum pernah -> tulis')
eq(shouldPersistPrices(null, Date.parse('2026-11-27T00:00:00.000Z')), true, 'throttle: null -> tulis')

console.log(`\nwatcher core-ask (v8.2): ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
