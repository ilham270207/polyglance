// Tes logika v8.3 (POST /ask-web) — tanpa token, tanpa network.
// Jalankan: node watcher/core-ask-web.test.mjs
import {
  isAskRefusalNeeded,
  ASK_REFUSAL,
  ASK_WEB_SYSTEM_PROMPT,
  buildAskWebMessages,
  parseAskWebAnswer,
  isValidAskWebQuestion,
  ASK_WEB_RATE_LIMIT_PER_MIN,
  ASK_WEB_CORS_HEADERS,
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

// --- system prompt /ask-web: tahu produk + crypto umum ---
ok(ASK_WEB_SYSTEM_PROMPT.includes('PolyGlance'), 'web prompt: nama produk')
ok(ASK_WEB_SYSTEM_PROMPT.includes('Even Realities G2'), 'web prompt: G2')
ok(ASK_WEB_SYSTEM_PROMPT.includes('@polyglance_alerts_bot'), 'web prompt: bot telegram')
ok(ASK_WEB_SYSTEM_PROMPT.includes('Morning Brief'), 'web prompt: morning brief')
ok(ASK_WEB_SYSTEM_PROMPT.includes('Hyperliquid'), 'web prompt: hyperliquid')
ok(ASK_WEB_SYSTEM_PROMPT.includes('paper trading'), 'web prompt: paper trading')
ok(ASK_WEB_SYSTEM_PROMPT.includes('simulator'), 'web prompt: coba tanpa kacamata (simulator)')
ok(ASK_WEB_SYSTEM_PROMPT.includes('Android companion APK'), 'web prompt: coba tanpa kacamata (apk)')
ok(ASK_WEB_SYSTEM_PROMPT.includes('free'), 'web prompt: gratis')
ok(ASK_WEB_SYSTEM_PROMPT.includes('Polymarket'), 'web prompt: polymarket umum')
ok(ASK_WEB_SYSTEM_PROMPT.includes('Fear & Greed'), 'web prompt: fear & greed umum')
ok(ASK_WEB_SYSTEM_PROMPT.includes('dorahacks.io/build/51900'), 'web prompt: build hackathon')
ok(ASK_WEB_SYSTEM_PROMPT.includes('built solo by developer ilham'), 'web prompt: solo builder ilham (bukan tim)')

// --- system prompt /ask-web: larangan TETAP (prediksi / advice) ---
ok(ASK_WEB_SYSTEM_PROMPT.includes('NEVER predict'), 'web prompt: larang prediksi')
ok(ASK_WEB_SYSTEM_PROMPT.includes('NEVER give financial advice'), 'web prompt: larang advice')
ok(ASK_WEB_SYSTEM_PROMPT.includes('NEVER recommend buying or selling'), 'web prompt: larang rekomendasi')
ok(ASK_WEB_SYSTEM_PROMPT.includes('I can share live data, not predictions or advice.'), 'web prompt: kalimat penolakan persis ASK_REFUSAL')
ok(ASK_WEB_SYSTEM_PROMPT.includes('Max 6 short lines'), 'web prompt: max 6 baris')
ok(ASK_WEB_SYSTEM_PROMPT.includes('quote real numbers'), 'web prompt: kutip angka live')
ok(ASK_WEB_SYSTEM_PROMPT.includes('plain ASCII'), 'web prompt: plain ascii')

// --- buildAskWebMessages: system + user (data live + pertanyaan) ---
const webMsgs = buildAskWebMessages('what is bitcoin?', ['BTC $60,388 (+3.2% 24h)', 'Fear & Greed: 11 (Extreme Fear)'])
eq(webMsgs.length, 2, 'buildAskWebMessages 2 pesan')
eq(webMsgs[0].role, 'system', 'buildAskWebMessages system')
eq(webMsgs[0].content, ASK_WEB_SYSTEM_PROMPT, 'buildAskWebMessages system = prompt web')
ok(webMsgs[1].content.includes('BTC $60,388'), 'buildAskWebMessages user bawa data live')
ok(webMsgs[1].content.includes('what is bitcoin?'), 'buildAskWebMessages user bawa pertanyaan')
const webMsgsNoData = buildAskWebMessages('who built polyglance?', [])
ok(webMsgsNoData[1].content.includes('no live data available'), 'buildAskWebMessages tanpa data -> penanda jelas')

// --- parseAskWebAnswer: sampai 6 baris, tiap baris <=200 karakter ---
eq(parseAskWebAnswer('Bitcoin is a digital currency.'), 'Bitcoin is a digital currency.', 'parseAskWebAnswer 1 baris')
eq(parseAskWebAnswer('One.\nTwo.\nThree.\nFour.\nFive.\nSix.\nSeven.'), 'One.\nTwo.\nThree.\nFour.\nFive.\nSix.', 'parseAskWebAnswer potong ke 6 baris')
eq(parseAskWebAnswer(''), null, 'parseAskWebAnswer kosong -> null')
eq(parseAskWebAnswer(null), null, 'parseAskWebAnswer null -> null')
eq(parseAskWebAnswer('   \n\n  '), null, 'parseAskWebAnswer hanya spasi -> null')
ok(parseAskWebAnswer('x'.repeat(250)).length <= 200, 'parseAskWebAnswer baris <=200')
ok(parseAskWebAnswer('a'.repeat(199) + '\n' + 'b'.repeat(201)).split('\n')[1].length === 200, 'parseAskWebAnswer baris ke-2 dipotong 200')
eq(parseAskWebAnswer('  padded line  \n\nsecond'), 'padded line\nsecond', 'parseAskWebAnswer trim + buang baris kosong')

// --- validasi pertanyaan: 3..500 karakter ---
eq(isValidAskWebQuestion('what is bitcoin?'), true, 'validasi: pertanyaan umum lolos')
eq(isValidAskWebQuestion('abc'), true, 'validasi: 3 karakter lolos')
eq(isValidAskWebQuestion('x'.repeat(500)), true, 'validasi: 500 karakter lolos')
eq(isValidAskWebQuestion('hi'), false, 'validasi: 2 karakter ditolak')
eq(isValidAskWebQuestion(''), false, 'validasi: kosong ditolak')
eq(isValidAskWebQuestion('   '), false, 'validasi: hanya spasi ditolak')
eq(isValidAskWebQuestion('x'.repeat(501)), false, 'validasi: 501 karakter ditolak')
eq(isValidAskWebQuestion(null), false, 'validasi: null ditolak')
eq(isValidAskWebQuestion(123), false, 'validasi: bukan string ditolak')
eq(isValidAskWebQuestion('  what is bitcoin?  '), true, 'validasi: spasi luar di-trim, isi lolos')

// --- routing penolakan: pertanyaan umum LOLOS, prediksi/advice DITOLAK ---
// (pre-check deterministik yang sama dengan /ask; sisanya ditangani system
// prompt — mis. "is ethereum a good investment?" lolos pre-check tapi
// prompt memerintahkan model membalas persis ASK_REFUSAL.)
eq(isAskRefusalNeeded('what is bitcoin?'), false, 'web: what is bitcoin -> dijawab')
eq(isAskRefusalNeeded('who built polyglance?'), false, 'web: who built polyglance -> dijawab')
eq(isAskRefusalNeeded('can i try polyglance on my phone?'), false, 'web: try on phone -> dijawab')
eq(isAskRefusalNeeded('how much polymarket today'), false, 'web: how much polymarket -> dijawab')
eq(isAskRefusalNeeded('is btc fear or greed right now?'), false, 'web: fear or greed -> dijawab')
eq(isAskRefusalNeeded('should i buy bitcoin?'), true, 'web: should i buy -> ditolak')
eq(isAskRefusalNeeded('is ethereum a good investment?'), false, 'web: good investment -> lolos pre-check, ditolak model via prompt')
eq(isAskRefusalNeeded('give me investment advice'), true, 'web: advice -> ditolak')
eq(isAskRefusalNeeded('will bitcoin reach 100k?'), true, 'web: will reach -> ditolak')
eq(isAskRefusalNeeded('predict bitcoin price'), true, 'web: predict -> ditolak')
eq(ASK_REFUSAL, 'I can share live data, not predictions or advice.', 'teks penolakan web = ASK_REFUSAL')

// --- rate cap + CORS (konstanta yang dipakai worker.js) ---
eq(ASK_WEB_RATE_LIMIT_PER_MIN, 60, 'rate cap web: 60/menit')
eq(ASK_WEB_CORS_HEADERS['Access-Control-Allow-Origin'], '*', 'cors web: origin *')
ok(ASK_WEB_CORS_HEADERS['Access-Control-Allow-Methods'].includes('POST'), 'cors web: metode POST')
ok(ASK_WEB_CORS_HEADERS['Access-Control-Allow-Methods'].includes('OPTIONS'), 'cors web: metode OPTIONS')
ok(ASK_WEB_CORS_HEADERS['Access-Control-Allow-Headers'].includes('Content-Type'), 'cors web: header Content-Type')

console.log(`\nwatcher core-ask-web (v8.3): ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
