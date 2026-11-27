// Unit test modul v8.2 WHALES / MOOD / ASK (client kacamata) — tanpa network, tanpa SDK.
// Jalankan: node tests/whales-mood-ask.test.js
// (meng-compile src/whales.ts, src/mood.ts, src/ask.ts dulu dengan tsc ke /tmp.)

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname
const outDir = mkdtempSync(join(tmpdir(), 'pg-v82-test-'))
execSync(`npx tsc src/whales.ts src/mood.ts src/ask.ts --outDir ${outDir} --module nodenext --target es2020 --moduleResolution nodenext --skipLibCheck`, {
  cwd: ROOT,
  stdio: 'pipe',
})
const whales = await import(pathToFileURL(join(outDir, 'whales.js')).href)
const mood = await import(pathToFileURL(join(outDir, 'mood.js')).href)
const ask = await import(pathToFileURL(join(outDir, 'ask.js')).href)

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

// --- WHALES: format ---
eq(whales.formatWhaleUsd(12400), '$12.4K', 'whale usd 12.4K')
eq(whales.formatWhaleUsd(150000), '$150K', 'whale usd 150K')
eq(whales.formatWhaleUsd(1240000), '$1.2M', 'whale usd 1.2M')
eq(whales.formatWhaleUsd(999), '$999', 'whale usd 999')
eq(whales.formatWhaleUsd(1000), '$1.0K', 'whale usd 1.0K')
ok(whales.shortWhaleQuestion('Will Bitcoin dip to $55,000 in November?', 16).length <= 16, 'short question <=16')
ok(whales.shortWhaleQuestion('Will Bitcoin dip to $55,000 in November?', 16).endsWith('?'), 'short question ends ?')
eq(whales.whaleAge(0), 'just now', 'age just now')
eq(whales.whaleAge(5), '5m ago', 'age 5m')
eq(whales.whaleAge(90), '1h ago', 'age 1h')

// --- WHALES: baris layar (<=34 karakter, ASCII) ---
const t1 = { question: 'Will Bitcoin dip to $55,000 in November?', outcome: 'YES', usd: 12400, pct: 48, trader: 'whale123', mins: 2 }
const [w1a, w1b] = whales.whaleTradeLines(t1)
ok(w1a.length <= 34, `whale line1 <=34 (${w1a.length}): ${w1a}`)
ok(w1a.includes('$12.4K YES'), `whale line1 isi: ${w1a}`)
ok(w1a.includes('48%'), `whale line1 odds: ${w1a}`)
ok(w1b.length <= 34, `whale line2 <=34: ${w1b}`)
ok(w1b.includes('whale123') && w1b.includes('2m ago'), `whale line2 isi: ${w1b}`)

const wlEmpty = whales.whaleLines(null, false, '')
eq(wlEmpty, ['WHALES - BIG POLYMARKET BETS', 'loading whales...', 'tap: mood >'], 'whales loading')
const wlOffline = whales.whaleLines([], true, '')
ok(wlOffline.includes('OFFLINE - no data yet'), 'whales offline empty')
const wlLoadedEmpty = whales.whaleLines([], false, '', true)
eq(wlLoadedEmpty, ['WHALES - BIG POLYMARKET BETS', 'no whales right now', 'tap: mood >'], 'whales loaded empty')
const wlLoadedNull = whales.whaleLines(null, false, '', true)
ok(wlLoadedNull.includes('no whales right now'), 'whales loaded null = no whales')
const wlNotLoadedEmpty = whales.whaleLines([], false, '')
eq(wlNotLoadedEmpty, ['WHALES - BIG POLYMARKET BETS', 'loading whales...', 'tap: mood >'], 'whales not loaded empty = loading')
ok(wlLoadedEmpty.every((l) => l.length <= 34), 'whales loaded-empty semua baris <=34')
const wl3 = whales.whaleLines([t1, t1, t1, t1], false, '12:00:00')
ok(wl3.length <= 8, `whales 3 trade = <=8 baris (${wl3.length})`)
ok(wl3[0] === 'WHALES - BIG POLYMARKET BETS', 'whales header')
ok(wl3[wl3.length - 1] === 'tap: mood >', 'whales footer')
ok(wl3.every((l) => l.length <= 34), 'semua baris whales <=34')

// --- MOOD: skor ---
eq(mood.computeMoodLevel({ fng: 11, fngLabel: 'Extreme Fear', btcChg: -3.5, topMover: null, fundingAvg: 0.0001 }), 'risk-off', 'mood risk-off')
eq(mood.computeMoodLevel({ fng: 75, fngLabel: 'Greed', btcChg: 4, topMover: null, fundingAvg: 0.002 }), 'euphoric', 'mood euphoric')
eq(mood.computeMoodLevel({ fng: 50, fngLabel: 'Neutral', btcChg: 0, topMover: null, fundingAvg: 0 }), 'neutral', 'mood neutral')
eq(mood.computeMoodLevel({ fng: null, fngLabel: '', btcChg: null, topMover: null, fundingAvg: null }), 'neutral', 'mood tanpa data = neutral')
eq(mood.computeMoodLevel({ fng: 30, fngLabel: 'Fear', btcChg: null, topMover: null, fundingAvg: null }), 'cautious', 'mood cautious (fng 30)')
eq(mood.fundingWord(0.006), 'very hot', 'funding very hot')
eq(mood.fundingWord(0.002), 'warm', 'funding warm')
eq(mood.fundingWord(0.0005), 'mild', 'funding mild')
eq(mood.fundingWord(-0.0005), 'cooling', 'funding cooling')
eq(mood.fundingWord(-0.002), 'cold', 'funding cold')
eq(mood.fundingWord(null), 'no funding data', 'funding null')

// --- MOOD: baris layar ---
const ml = mood.moodLines({ fng: 11, fngLabel: 'Extreme Fear', btcChg: -3.5, topMover: { symbol: 'SOL', chg: 4.1 }, fundingAvg: 0.0001 })
ok(ml.length <= 8, `mood <=8 baris (${ml.length})`)
ok(ml.every((l) => l.length <= 34), `semua baris mood <=34: ${JSON.stringify(ml)}`)
eq(ml[0], 'MOOD - MARKET IN ONE LOOK', 'mood header')
ok(ml.some((l) => l.includes('FEAR 11 - EXTREME FEAR')), `mood fng: ${JSON.stringify(ml)}`)
ok(ml.some((l) => l.includes('BTC -3.5% 24h')), `mood btc: ${JSON.stringify(ml)}`)
ok(ml.some((l) => l.includes('SOL +4.1%')), `mood top mover: ${JSON.stringify(ml)}`)
ok(ml.some((l) => l.includes('mood: risk-off')), `mood level: ${JSON.stringify(ml)}`)
eq(ml[ml.length - 1], 'tap: sltp >', 'mood footer')
const mlEmpty = mood.moodLines({ fng: null, fngLabel: '', btcChg: null, topMover: null, fundingAvg: null })
ok(mlEmpty.includes('FEAR - no data'), 'mood tanpa fng')
ok(mlEmpty.includes('prices loading...'), 'mood tanpa harga')
ok(mlEmpty.includes('funding loading...'), 'mood tanpa funding')

// --- ASK: bungkus jawaban + base URL ---
const wrapped = ask.wrapAskAnswer('BTC is $60,388, up 3.2% in 24h. Fear is 11, extreme fear.')
ok(wrapped.length <= 4, `wrap <=4 baris (${wrapped.length})`)
ok(wrapped.every((l) => l.length <= 34), `wrap semua <=34: ${JSON.stringify(wrapped)}`)
ok(wrapped.join(' ').includes('BTC is $60,388'), 'wrap isi utuh')
eq(ask.wrapAskAnswer('a'.repeat(200)).length, 1, 'wrap kata super panjang -> 1 baris 34')
eq(ask.wrapAskAnswer('a'.repeat(200))[0].length, 34, 'wrap kata super panjang = 34 char')
eq(ask.getAskBaseUrl(), 'https://polyglance-watcher.danham322.workers.dev', 'ask base url fallback (tanpa settings)')

// --- ASK: strip kata pemicu "ask" dari echo tampilan (F3, v8.3) ---
eq(ask.stripAskTrigger('ask is btc fear or greed?'), 'is btc fear or greed?', 'strip ask di awal')
eq(ask.stripAskTrigger('ask why is bitcoin down'), 'why is bitcoin down', 'strip ask + why')
eq(ask.stripAskTrigger('Ask IS btc fear or greed?'), 'IS btc fear or greed?', 'strip ask kapital, sisa utuh')
eq(ask.stripAskTrigger('why is bitcoin down?'), 'why is bitcoin down?', 'tanpa pemicu -> utuh')
eq(ask.stripAskTrigger('ask'), 'ask', 'ask saja -> utuh')
eq(ask.stripAskTrigger('askew question here'), 'askew question here', 'askew bukan pemicu')
eq(ask.stripAskTrigger('  ask is btc up?  '), 'is btc up?', 'strip + trim spasi')

console.log(`\nwhales-mood-ask: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
