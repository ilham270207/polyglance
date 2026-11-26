// Unit test parser voice PolyGlance v5 — tanpa mic, tanpa network, tanpa SDK.
// Jalankan: node tests/voice-parser.test.js
// (meng-compile src/voice.ts dulu dengan tsc ke /tmp, lalu import hasil compile.)

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname
const outDir = mkdtempSync(join(tmpdir(), 'pg-voice-test-'))
execSync(`npx tsc src/voice.ts --outDir ${outDir} --module nodenext --target es2020 --moduleResolution nodenext --skipLibCheck`, {
  cwd: ROOT,
  stdio: 'pipe',
})
const { parseVoiceCommand, wordsToNumber, pcmToWav, rmsLevel } = await import(
  pathToFileURL(join(outDir, 'voice.js')).href
)

let pass = 0
let fail = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; }
  else { fail++; console.log(`FAIL ${label}\n  got:      ${a}\n  expected: ${e}`) }
}

// --- kata-angka ---
eq(wordsToNumber(['fifty', 'eight', 'thousand']), 58000, 'fifty eight thousand')
eq(wordsToNumber(['one', 'hundred']), 100, 'one hundred')
eq(wordsToNumber(['fifty', 'eight']), 58, 'fifty eight')
eq(wordsToNumber(['58000']), 58000, 'digit 58000')
eq(wordsToNumber(['58,000']), 58000, 'digit 58,000')
eq(wordsToNumber(['one', 'million']), 1000000, 'one million')
eq(wordsToNumber(['two', 'hundred', 'fifty']), 250, 'two hundred fifty')
eq(wordsToNumber(['hello']), null, 'bukan angka')

// --- pindah view ---
eq(parseVoiceCommand('ticker'), { type: 'goto', view: 'ticker' }, 'ticker')
eq(parseVoiceCommand('bitcoin price'), { type: 'goto', view: 'ticker' }, 'bitcoin price')
eq(parseVoiceCommand('show me the odds'), { type: 'goto', view: 'odds' }, 'odds')
eq(parseVoiceCommand('paper'), { type: 'goto', view: 'paper-btc' }, 'paper')
eq(parseVoiceCommand('go to alerts'), { type: 'goto', view: 'alerts' }, 'alerts')
eq(parseVoiceCommand('next'), { type: 'next' }, 'next')
eq(parseVoiceCommand('back'), { type: 'back' }, 'back')
eq(parseVoiceCommand('refresh'), { type: 'refresh' }, 'refresh')

// --- buy / sell ---
eq(parseVoiceCommand('buy one hundred bitcoin'), { type: 'buy', coin: 'BTC' }, 'buy 100 btc kata')
eq(parseVoiceCommand('buy btc'), { type: 'buy', coin: 'BTC' }, 'buy btc')
eq(parseVoiceCommand('purchase ethereum'), { type: 'buy', coin: 'ETH' }, 'purchase eth')
eq(parseVoiceCommand('sell one hundred ethereum'), { type: 'sell', coin: 'ETH' }, 'sell 100 eth')
eq(parseVoiceCommand('sell bitcoin'), { type: 'sell', coin: 'BTC' }, 'sell btc')
eq(parseVoiceCommand('buy'), null, 'buy tanpa coin -> null (jangan nebak)')

// --- set alert ---
eq(parseVoiceCommand('set alert to fifty eight thousand'), { type: 'set-alert', target: 58000 }, 'alert kata')
eq(parseVoiceCommand('alert 58000'), { type: 'set-alert', target: 58000 }, 'alert digit')
eq(parseVoiceCommand('set alert fifty eight thousand'), { type: 'set-alert', target: 58000 }, 'alert tanpa to')
eq(parseVoiceCommand('set alert eth 1800'), { type: 'set-alert', target: 1800, coin: 'ETH' }, 'alert eth berkoin')
eq(parseVoiceCommand('alert sol 150'), { type: 'set-alert', target: 150, coin: 'SOL' }, 'alert sol berkoin')
eq(parseVoiceCommand('set alert bitcoin 60000'), { type: 'set-alert', target: 60000, coin: 'BTC' }, 'alert btc berkoin')
eq(parseVoiceCommand('alert 100'), { type: 'set-alert', target: 100 }, 'alert 100 diterima parser (validasi per-aset di main.ts)')
eq(parseVoiceCommand('alert 5'), null, 'alert 5 di bawah lantai parser 10 -> null')
eq(parseVoiceCommand('set alert'), null, 'alert tanpa angka -> null')

// --- jual semua (v6) ---
eq(parseVoiceCommand('sell all bitcoin'), { type: 'sell-all', coin: 'BTC' }, 'sell all btc')
eq(parseVoiceCommand('sell all ethereum'), { type: 'sell-all', coin: 'ETH' }, 'sell all eth')
eq(parseVoiceCommand('sell all'), { type: 'sell-all', coin: 'ALL' }, 'sell all = btc+eth')
eq(parseVoiceCommand('sell all solana'), null, 'sell all sol -> null (tanpa paper holding)')
eq(parseVoiceCommand('sell everything'), null, 'sell everything tanpa all/coin -> null')

// --- hapus alert (v6) ---
eq(parseVoiceCommand('cancel alert'), { type: 'cancel-alert' }, 'cancel alert')
eq(parseVoiceCommand('remove alert'), { type: 'cancel-alert' }, 'remove alert')
eq(parseVoiceCommand('delete alert'), { type: 'cancel-alert' }, 'delete alert')
eq(parseVoiceCommand('clear alert'), { type: 'cancel-alert' }, 'clear alert')
eq(parseVoiceCommand('cancel'), { type: 'stop' }, 'cancel saja tetap stop')

// --- odds alert (v7) ---
eq(parseVoiceCommand('set odds alert above 60'), { type: 'set-odds-alert', threshold: 60, direction: 'above' }, 'odds alert above 60')
eq(parseVoiceCommand('odds alert below 40'), { type: 'set-odds-alert', threshold: 40, direction: 'below' }, 'odds alert below 40')
eq(parseVoiceCommand('set odds alert 60'), { type: 'set-odds-alert', threshold: 60, direction: 'above' }, 'odds alert tanpa arah = above')
eq(parseVoiceCommand('set odds alert above sixty'), { type: 'set-odds-alert', threshold: 60, direction: 'above' }, 'odds alert kata-angka')
eq(parseVoiceCommand('set odds alert under 25'), { type: 'set-odds-alert', threshold: 25, direction: 'below' }, 'odds alert under = below')
eq(parseVoiceCommand('cancel odds alert'), { type: 'cancel-odds-alert' }, 'cancel odds alert')
eq(parseVoiceCommand('remove odds alert'), { type: 'cancel-odds-alert' }, 'remove odds alert')
eq(parseVoiceCommand('odds alert'), { type: 'goto', view: 'odds-alert' }, 'odds alert tanpa angka = buka view')
eq(parseVoiceCommand('show odds alert'), { type: 'goto', view: 'odds-alert' }, 'show odds alert = buka view')
eq(parseVoiceCommand('set odds alert above 120'), null, 'odds alert >95 -> null')
eq(parseVoiceCommand('set odds alert above 3'), null, 'odds alert <5 -> null')
eq(parseVoiceCommand('show me the odds'), { type: 'goto', view: 'odds' }, 'odds biasa tetap ke view odds')
eq(parseVoiceCommand('cancel alert'), { type: 'cancel-alert' }, 'cancel alert biasa tetap cancel-alert')
eq(parseVoiceCommand('set alert eth 1800'), { type: 'set-alert', target: 1800, coin: 'ETH' }, 'alert harga tetap price alert')

// --- portfolio (v6, eksplisit) ---
eq(parseVoiceCommand('show portfolio'), { type: 'goto', view: 'paper-btc' }, 'show portfolio')
eq(parseVoiceCommand('check portfolio'), { type: 'goto', view: 'paper-btc' }, 'check portfolio')

// --- stop & tidak dikenal ---
eq(parseVoiceCommand('stop'), { type: 'stop' }, 'stop')
eq(parseVoiceCommand('cancel'), { type: 'stop' }, 'cancel')
eq(parseVoiceCommand('hello world'), null, 'tidak dikenal -> null')
eq(parseVoiceCommand(''), null, 'kosong -> null')
eq(parseVoiceCommand('Buy ONE HUNDRED Bitcoin!'), { type: 'buy', coin: 'BTC' }, 'kapital + tanda baca')
eq(parseVoiceCommand('set alert to fifty-eight thousand'), { type: 'set-alert', target: 58000 }, 'hyphen')

// --- wav packing ---
const pcm = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80])
const wav = pcmToWav(pcm)
eq(wav.length, 50, 'wav length = 44 + pcm')
eq(String.fromCharCode(...wav.slice(0, 4)), 'RIFF', 'wav RIFF')
eq(String.fromCharCode(...wav.slice(8, 12)), 'WAVE', 'wav WAVE')
eq(new DataView(wav.buffer).getUint32(24, true), 16000, 'wav sample rate 16000')
eq(new DataView(wav.buffer).getUint16(22, true), 1, 'wav mono')
eq(rmsLevel(new Uint8Array(3200)), 0, 'rms silence = 0')
const loud = new Uint8Array(3200)
for (let i = 0; i < 1600; i++) { loud[i * 2] = 0x00; loud[i * 2 + 1] = 0x40; } // 0x4000 = 0.5
const rms = rmsLevel(loud)
if (rms > 0.4 && rms <= 1) { pass++; } else { fail++; console.log(`FAIL rms loud: ${rms}`) }

console.log(`\nvoice-parser: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
