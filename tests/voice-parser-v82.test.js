// Unit test parser voice PolyGlance v8.2 (DELTA) — tanpa mic, tanpa network, tanpa SDK.
// Jalankan: node tests/voice-parser-v82.test.js
// (meng-compile src/voice.ts dulu dengan tsc ke /tmp, lalu import hasil compile.)
// File ini HANYA menguji yang baru di v8.2 (intent ASK + goto whales/mood/ask
// + precedence vs perintah lama). Test v8.1 (74 kasus, tests/voice-parser.test.js
// dari repo) tetap dijalankan terpisah dan harus tetap lolos.

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
const { parseVoiceCommand } = await import(
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

// --- intent ASK (v8.2): pertanyaan bebas -> {type:'ask', question} ---
eq(parseVoiceCommand('why is bitcoin down?'), { type: 'ask', question: 'why is bitcoin down?' }, 'ask why btc down')
eq(parseVoiceCommand('why is bitcoin down'), { type: 'ask', question: 'why is bitcoin down' }, 'ask tanpa tanda tanya tetap ask')
eq(parseVoiceCommand('is bitcoin fear or greed?'), { type: 'ask', question: 'is bitcoin fear or greed?' }, 'ask fear or greed')
eq(parseVoiceCommand('will bitcoin reach 100k?'), { type: 'ask', question: 'will bitcoin reach 100k?' }, 'ask prediksi -> ask (penolakan di Worker)')
eq(parseVoiceCommand('should i buy bitcoin'), { type: 'ask', question: 'should i buy bitcoin' }, 'ask advice -> ask (penolakan di Worker)')
eq(parseVoiceCommand('how much is bitcoin'), { type: 'ask', question: 'how much is bitcoin' }, 'ask how much')
eq(parseVoiceCommand('tell me why bitcoin is down'), { type: 'ask', question: 'tell me why bitcoin is down' }, 'ask tell me')
eq(parseVoiceCommand('is solana going up'), { type: 'ask', question: 'is solana going up' }, 'ask solana')
eq(parseVoiceCommand('what is fear and greed today'), { type: 'ask', question: 'what is fear and greed today' }, 'ask fng')

// --- ASK: batas ---
eq(parseVoiceCommand('why?'), null, 'why saja (<3 token) -> null')
eq(parseVoiceCommand('explain bitcoin'), null, 'explain + 1 kata (<3 token) -> null')
eq(parseVoiceCommand('ask why is bitcoin down'), { type: 'ask', question: 'ask why is bitcoin down' }, 'ask + pertanyaan panjang -> ask, bukan goto')

// --- goto baru (v8.2) ---
eq(parseVoiceCommand('show whales'), { type: 'goto', view: 'whales' }, 'show whales')
eq(parseVoiceCommand('whales'), { type: 'goto', view: 'whales' }, 'whales saja')
eq(parseVoiceCommand('show mood'), { type: 'goto', view: 'mood' }, 'show mood')
eq(parseVoiceCommand('mood'), { type: 'goto', view: 'mood' }, 'mood saja')
eq(parseVoiceCommand('ask'), { type: 'goto', view: 'ask' }, 'ask saja -> goto ask')
eq(parseVoiceCommand('show ask'), { type: 'goto', view: 'ask' }, 'show ask -> goto ask')

// --- precedence: perintah konkret MENANG atas intent ASK ---
eq(parseVoiceCommand('what is the price of bitcoin'), { type: 'goto', view: 'ticker' }, 'what is price -> goto ticker (bukan ask)')
eq(parseVoiceCommand('can you show me the ticker'), { type: 'goto', view: 'ticker' }, 'can you show ticker -> goto ticker')
eq(parseVoiceCommand('what is my portfolio'), { type: 'goto', view: 'paper-btc' }, 'what is portfolio -> goto paper')
eq(parseVoiceCommand('buy bitcoin'), { type: 'buy', coin: 'BTC' }, 'buy tetap buy (bukan ask)')
eq(parseVoiceCommand('set alert to fifty eight thousand'), { type: 'set-alert', target: 58000 }, 'alert tetap alert (bukan ask)')
eq(parseVoiceCommand('set odds alert above 60'), { type: 'set-odds-alert', threshold: 60, direction: 'above' }, 'odds alert tetap odds alert')
eq(parseVoiceCommand('sell all bitcoin'), { type: 'sell-all', coin: 'BTC' }, 'sell all tetap sell-all')
eq(parseVoiceCommand('show hyperliquid'), { type: 'goto', view: 'hl' }, 'show hyperliquid tetap hl')

console.log(`\nvoice-parser-v82: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
