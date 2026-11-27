// Unit test modul v8.4 PAPER SL/TP + NEWS + voice goto (client kacamata) —
// tanpa network, tanpa SDK.
// Jalankan: node tests/paper-sltp-news.test.js
// (meng-compile src/sltp.ts, src/news.ts, src/voice.ts dulu dengan tsc ke /tmp.)

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname
const outDir = mkdtempSync(join(tmpdir(), 'pg-v84-test-'))
execSync(`npx tsc src/sltp.ts src/news.ts src/voice.ts src/odds.ts --outDir ${outDir} --module nodenext --target es2020 --moduleResolution nodenext --skipLibCheck`, {
  cwd: ROOT,
  stdio: 'pipe',
})
const sltp = await import(pathToFileURL(join(outDir, 'sltp.js')).href)
const news = await import(pathToFileURL(join(outDir, 'news.js')).href)
const { parseVoiceCommand } = await import(pathToFileURL(join(outDir, 'voice.js')).href)
const odds = await import(pathToFileURL(join(outDir, 'odds.js')).href)

let pass = 0
let fail = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++ }
  else { fail++; console.log(`FAIL ${label}\n  got:      ${a}\n  expected: ${e}`) }
}
function ok(cond, label) {
  if (cond) { pass++ }
  else { fail++; console.log(`FAIL ${label}`) }
}
function near(actual, expected, eps, label) {
  if (Math.abs(actual - expected) <= eps) { pass++ }
  else { fail++; console.log(`FAIL ${label}\n  got: ${actual}, expected ~${expected}`) }
}
function linesOk(lines, label) {
  ok(Array.isArray(lines) && lines.length <= 8, `${label} (<=8 baris, dapat ${lines.length})`)
  for (const l of lines) {
    if (l.length > 34) { fail++; console.log(`FAIL ${label} (baris >34): ${JSON.stringify(l)}`) }
    else pass++
    if (/[^\x00-\x7F]/.test(l)) { fail++; console.log(`FAIL ${label} (non-ASCII): ${JSON.stringify(l)}`) }
    else pass++
  }
}

// ---------- slTpPct ----------
eq(sltp.slTpPct(63000, 60000), 5, 'pct +5%')
eq(sltp.slTpPct(57000, 60000), -5, 'pct -5%')
near(sltp.slTpPct(61200, 60000), 2, 0.001, 'pct +2%')
eq(sltp.slTpPct(60000, null), null, 'pct entry null -> null')
eq(sltp.slTpPct(0, 60000), null, 'pct price 0 -> null')
eq(sltp.slTpPct(60000, 0), null, 'pct entry 0 -> null')

// ---------- slTpHit ----------
const pos = { sym: 'BTC', holding: 0.001, entry: 60000, sl: -5, tp: 10 }
eq(sltp.slTpHit(pos, 57000), 'sl', 'hit SL tepat -5%')
eq(sltp.slTpHit(pos, 56999), 'sl', 'hit SL di bawah -5%')
eq(sltp.slTpHit(pos, 57001), null, 'tidak hit di atas SL')
eq(sltp.slTpHit(pos, 66000), 'tp', 'hit TP tepat +10%')
eq(sltp.slTpHit(pos, 65999), null, 'tidak hit di bawah TP')
eq(sltp.slTpHit(pos, 60000), null, 'tidak hit di entry')
eq(sltp.slTpHit({ ...pos, sl: null }, 50000), null, 'SL null -> tidak hit SL')
eq(sltp.slTpHit({ ...pos, tp: null }, 90000), null, 'TP null -> tidak hit TP')
eq(sltp.slTpHit({ ...pos, holding: 0 }, 50000), null, 'holding 0 -> tidak hit')
eq(sltp.slTpHit({ ...pos, entry: null }, 50000), null, 'entry null -> tidak hit')
// SL dicek dulu: pct -60% kena SL walau TP juga tidak mungkin kena bersamaan
eq(sltp.slTpHit({ ...pos, sl: -5, tp: 10 }, 10000), 'sl', 'crash dalam -> SL')

// ---------- slTpEntryAfterBuy ----------
eq(sltp.slTpEntryAfterBuy(0, null, 60000, 100), 60000, 'posisi baru -> entry = harga beli')
eq(sltp.slTpEntryAfterBuy(0, 50000, 60000, 100), 60000, 'holding 0 -> entry = harga beli')
near(sltp.slTpEntryAfterBuy(0.001, 60000, 66000, 100), 63614.46, 0.01, 'tambah posisi -> rata-rata tertimbang')
near(sltp.slTpEntryAfterBuy(0.001, 60000, 60000, 100), 60000, 0.001, 'tambah di harga sama -> entry tetap')

// ---------- adjustSlTp ----------
eq(sltp.adjustSlTp('sl', -5, 1), -4, 'SL -5 +1 -> -4')
eq(sltp.adjustSlTp('sl', -5, -1), -6, 'SL -5 -1 -> -6')
eq(sltp.adjustSlTp('sl', -1, 1), -1, 'SL mentok -1')
eq(sltp.adjustSlTp('sl', -50, -1), -50, 'SL mentok -50')
eq(sltp.adjustSlTp('sl', null, 1), -4, 'SL null -> default -5 lalu +1')
eq(sltp.adjustSlTp('tp', 10, 1), 11, 'TP 10 +1 -> 11')
eq(sltp.adjustSlTp('tp', 10, -1), 9, 'TP 10 -1 -> 9')
eq(sltp.adjustSlTp('tp', 1, -1), 1, 'TP mentok 1')
eq(sltp.adjustSlTp('tp', 100, 1), 100, 'TP mentok 100')
eq(sltp.adjustSlTp('tp', null, -1), 9, 'TP null -> default 10 lalu -1')

// ---------- slTpLines ----------
const onePos = [{ sym: 'BTC', holding: 0.0017, entry: 60000, sl: -5, tp: 10 }]
const linesOne = sltp.slTpLines({
  positions: onePos, selected: 0, field: 'sl',
  prices: { BTC: 61200, ETH: 0 }, lastClose: '', nextViewLabel: 'news',
})
linesOk(linesOne, 'sltp 1 posisi')
eq(linesOne[0], 'PAPER SL/TP - auto-close', 'sltp header')
ok(linesOne.some((l) => l.includes('BTC 0.0017 = $104')), 'sltp holding + nilai')
ok(linesOne.some((l) => l.includes('entry $60,000') && l.includes('now +2.0%')), 'sltp entry + pct')
ok(linesOne.some((l) => l === '>SL -5%  TP +10%'), 'sltp field SL ditandai >')
ok(linesOne.some((l) => l.includes('up: +1%') && l.includes('(SL)')), 'sltp hint swipe SL')
ok(linesOne.some((l) => l === 'dbl-tap: edit TP/SL'), 'sltp hint dbl-tap')
ok(linesOne[linesOne.length - 1] === 'tap: news >', 'sltp footer 1 posisi -> news')
const linesTp = sltp.slTpLines({
  positions: onePos, selected: 0, field: 'tp',
  prices: { BTC: 61200, ETH: 0 }, lastClose: '', nextViewLabel: 'news',
})
ok(linesTp.some((l) => l === 'SL -5%  >TP +10%'), 'sltp field TP ditandai >')
ok(linesTp.some((l) => l.includes('(TP)')), 'sltp hint swipe TP')
const twoPos = [
  { sym: 'BTC', holding: 0.0017, entry: 60000, sl: -5, tp: 10 },
  { sym: 'ETH', holding: 0.05, entry: 2000, sl: -5, tp: 10 },
]
const linesTwo0 = sltp.slTpLines({
  positions: twoPos, selected: 0, field: 'sl',
  prices: { BTC: 61200, ETH: 2100 }, lastClose: '', nextViewLabel: 'news',
})
ok(linesTwo0[linesTwo0.length - 1] === 'tap: next coin >', 'sltp footer posisi pertama -> next coin')
const linesTwo1 = sltp.slTpLines({
  positions: twoPos, selected: 1, field: 'sl',
  prices: { BTC: 61200, ETH: 2100 }, lastClose: '', nextViewLabel: 'news',
})
ok(linesTwo1.some((l) => l.includes('ETH 0.0500 = $105')), 'sltp posisi ETH')
ok(linesTwo1[linesTwo1.length - 1] === 'tap: news >', 'sltp footer posisi terakhir -> news')
const linesClose = sltp.slTpLines({
  positions: [], selected: 0, field: 'sl',
  prices: { BTC: 61200, ETH: 2100 }, lastClose: 'BTC TP +10.2% closed $66,120', nextViewLabel: 'news',
})
linesOk(linesClose, 'sltp tanpa posisi')
ok(linesClose.includes('no open positions'), 'sltp tanpa posisi -> pesan')
ok(linesClose.includes('BTC TP +10.2% closed $66,120'), 'sltp lastClose tampil')
const linesNoPrice = sltp.slTpLines({
  positions: onePos, selected: 0, field: 'sl',
  prices: { BTC: 0, ETH: 0 }, lastClose: '', nextViewLabel: 'news',
})
ok(linesNoPrice.some((l) => l.includes('loading')), 'sltp tanpa harga -> loading')

// ---------- newsLines ----------
const linesLoading = news.newsLines(null, false, '', false)
eq(linesLoading, ['NEWS - CRYPTO HEADLINES', 'loading news...', 'tap: ticker >'], 'news loading')
eq(news.newsLines(null, false, '', true), ['NEWS - CRYPTO HEADLINES', 'no news right now', 'tap: ticker >'], 'news kosong setelah load')
eq(news.newsLines(null, true, '', true), ['NEWS - CRYPTO HEADLINES', 'OFFLINE - no data yet', 'tap: ticker >'], 'news offline tanpa data')
const four = [
  'Bitcoin hits new all-time high above $100,000',
  'Ethereum ETF inflows surge to record levels',
  'Solana network upgrade goes live today',
  'Fear and Greed Index drops to Extreme Fear',
]
const linesFour = news.newsLines(four, false, '12:00:00', true)
linesOk(linesFour, 'news 4 headline')
eq(linesFour[0], 'NEWS - CRYPTO HEADLINES', 'news header')
ok(linesFour.some((l) => l.startsWith('Bitcoin hits new all-time high')), 'news headline 1 tampil')
ok(linesFour.some((l) => l === 'updated 12:00:00'), 'news updated tampil')
ok(linesFour[linesFour.length - 1] === 'tap: ticker >', 'news footer')
const linesFive = news.newsLines([...four, 'Fifth headline should be cut off'], false, '', true)
eq(linesFive.filter((l) => l.includes('Fifth')).length, 0, 'news maks 4 headline tampil')
const longTitle = 'This is a very long crypto headline that definitely exceeds thirty four characters'
const linesLong = news.newsLines([longTitle], false, '', true)
ok(linesLong[1].length === 34 && linesLong[1].endsWith('...'), 'news judul panjang dipotong 34 + ...')
linesOk(linesLong, 'news judul panjang')
const linesOffline = news.newsLines(four.slice(0, 3), true, '', true)
ok(linesOffline.includes('OFFLINE - last data shown'), 'news offline + data lama')

// ---------- voice goto v8.4 ----------
eq(parseVoiceCommand('show sltp'), { type: 'goto', view: 'paper-sltp' }, 'voice show sltp')
eq(parseVoiceCommand('sltp'), { type: 'goto', view: 'paper-sltp' }, 'voice sltp saja')
eq(parseVoiceCommand('show news'), { type: 'goto', view: 'news' }, 'voice show news')
eq(parseVoiceCommand('show headlines'), { type: 'goto', view: 'news' }, 'voice show headlines')
eq(parseVoiceCommand('show mood'), { type: 'goto', view: 'mood' }, 'voice show mood (regresi)')
eq(parseVoiceCommand('stop loss'), { type: 'stop' }, 'voice stop loss -> stop (bukan goto)')

// ---------- label ODDS (src/odds.ts, dipindah dari main.ts v8.4) ----------
eq(odds.shortOddsLabel('Will Bitcoin dip to $55,000 in November?', 48), 'BTC dip $55,000? YES 48%', 'label btc dip')
eq(odds.shortOddsLabel('Will Ethereum reach $2,000 by the end of 2026?', 7), 'ETH reach $2,000? YES 7%', 'label eth reach')
eq(odds.shortOddsQuestion('Will Bitcoin dip to $55,000 in November?'), 'BTC dip $55,000?', 'label tanpa YES% buat odds-alert')
eq(odds.monthAbbr('Will Bitcoin dip to $55,000 in November?'), 'NOV', 'bulan november')
eq(odds.monthAbbr('Will Bitcoin reach $100,000 by December 31, 2026?'), 'DEC', 'bulan december')
eq(odds.monthAbbr('Will Ethereum reach $2,000?'), null, 'tanpa bulan -> null')

// dedupe: dua pasar sama aset + angka + YES% sama, beda bulan -> label kedua dapat suffix bulan
const dup2 = odds.dedupeOddsLabels([
  { question: 'Will Bitcoin dip to $55,000 in November?', yesPct: 48 },
  { question: 'Will Bitcoin dip to $55,000 in December?', yesPct: 48 },
])
eq(dup2[0], 'BTC dip $55,000? YES 48%', 'dedupe: pertama tetap')
eq(dup2[1], 'BTC dip $55,000? YES 48% DEC', 'dedupe: kedua + DEC')

// dedupe: tanpa tabrakan -> tidak berubah
const noDup = odds.dedupeOddsLabels([
  { question: 'Will Bitcoin dip to $55,000 in November?', yesPct: 48 },
  { question: 'Will Ethereum reach $2,000 by the end of 2026?', yesPct: 7 },
])
eq(noDup[0], 'BTC dip $55,000? YES 48%', 'dedupe: tanpa tabrakan 1')
eq(noDup[1], 'ETH reach $2,000? YES 7%', 'dedupe: tanpa tabrakan 2')

// dedupe: tiga label sama tanpa bulan -> nomor urut (2) dan (3)
const dup3 = odds.dedupeOddsLabels([
  { question: 'Will Bitcoin dip to $55,000?', yesPct: 48 },
  { question: 'Will Bitcoin dip to $55,000?', yesPct: 48 },
  { question: 'Will Bitcoin dip to $55,000?', yesPct: 48 },
])
eq(dup3[1], 'BTC dip $55,000? YES 48% (2)', 'dedupe: kedua (2)')
eq(dup3[2], 'BTC dip $55,000? YES 48% (3)', 'dedupe: ketiga (3)')

// dedupe: label tepat 34 karakter + tabrakan -> suffix tidak muat, label tetap valid
// 'DOGE reach $1,234,567.89? YES 100%' = 34 karakter persis.
const longDup = odds.dedupeOddsLabels([
  { question: 'Will Dogecoin reach $1,234,567.89?', yesPct: 100 },
  { question: 'Will Dogecoin reach $1,234,567.89?', yesPct: 100 },
])
eq(longDup[0].length, 34, 'dedupe: label dasar 34 karakter')
ok(longDup[0].length <= 34 && longDup[1].length <= 34, 'dedupe: label panjang tetap <= 34')
eq(longDup[0], longDup[1], 'dedupe: label 34 char dibiarkan sama (guard panjang)')

console.log(`paper-sltp-news: ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
