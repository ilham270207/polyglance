// Unit test logika fallback STT PolyGlance v5 — tanpa mic, tanpa network asli.
// Jalankan: node tests/stt-fallback.test.mjs
// (meng-compile src/stt.ts + src/voice.ts dulu dengan tsc ke /tmp, lalu import
// hasil compile; fetch + localStorage di-stub per kasus.)

import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname
const HOME = process.env.HOME || ''
const TSC_CANDIDATES = [
  join(ROOT, 'node_modules', '.bin', 'tsc'),
  join(HOME, 'polyglance-check', 'node_modules', '.bin', 'tsc'),
  'npx tsc',
]
const TSC = TSC_CANDIDATES.find((c) => c === 'npx tsc' || existsSync(c))

const outDir = mkdtempSync(join(tmpdir(), 'pg-stt-test-'))
execSync(
  `${TSC} src/stt.ts src/voice.ts --outDir ${outDir} --module nodenext --target es2020 --moduleResolution nodenext --skipLibCheck`,
  { cwd: ROOT, stdio: 'pipe' },
)
const stt = await import(pathToFileURL(join(outDir, 'stt.js')).href)
const { transcribePcm, getSttProxyUrl, setSttProxyUrl } = stt

// --- stub localStorage (Node tidak punya) ---
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

// --- stub fetch: perilaku diatur per kasus, semua panggilan dicatat ---
const calls = []
let behavior = null // (url) => Response-like | throw
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), method: opts?.method || 'GET' })
  const r = behavior(String(url))
  if (r instanceof Error) throw r
  return r
}
const okJson = (text) => ({ ok: true, status: 200, json: async () => ({ text }) })
const errStatus = (status) => ({ ok: false, status, json: async () => ({ error: 'x' }) })

const PCM = new Uint8Array(3200) // 100 ms "hening" — cukup untuk bungkus WAV
const PROXY = 'https://polyglance-watcher.test.workers.dev/stt'

let pass = 0
let fail = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++ }
  else { fail++; console.log(`FAIL ${label}\n  got:      ${a}\n  expected: ${e}`) }
}
function reset(proxyUrl) {
  calls.length = 0
  store.clear()
  if (proxyUrl) setSttProxyUrl(proxyUrl)
}

// 1. Direct sukses -> proxy TIDAK dipanggil
reset(PROXY)
behavior = (url) => (url.includes('api.groq.com') ? okJson(' buy 100 bitcoin ') : errStatus(500))
eq(await transcribePcm(PCM, 'gsk_test'), 'buy 100 bitcoin', 'direct sukses: transcript ter-trim')
eq(calls.length, 1, 'direct sukses: fetch 1x')
eq(calls[0].url.includes('api.groq.com'), true, 'direct sukses: hanya ke groq')

// 2. Direct throw (network/hang) -> proxy dipanggil, hasil proxy dipakai
reset(PROXY)
behavior = (url) =>
  url.includes('api.groq.com') ? (() => { throw new Error('network down') })() : okJson('set alert to 58000')
eq(await transcribePcm(PCM, 'gsk_test'), 'set alert to 58000', 'direct throw: fallback ke proxy')
eq(calls.length, 2, 'direct throw: fetch 2x')
eq(calls[1].url, PROXY, 'direct throw: panggilan ke-2 ke proxy')

// 3. Direct 500 -> proxy dipanggil
reset(PROXY)
behavior = (url) => (url.includes('api.groq.com') ? errStatus(500) : okJson('show odds'))
eq(await transcribePcm(PCM, 'gsk_test'), 'show odds', 'direct 500: fallback ke proxy')

// 4. Direct gagal + proxy kosong -> null, fetch 1x
reset(null)
behavior = () => { throw new Error('network down') }
eq(await transcribePcm(PCM, 'gsk_test'), null, 'tanpa proxy: gagal -> null')
eq(calls.length, 1, 'tanpa proxy: fetch 1x saja')

// 5. Direct '' (Whisper tidak mendengar apa-apa) -> proxy TIDAK dipanggil
reset(PROXY)
behavior = (url) => (url.includes('api.groq.com') ? okJson('   ') : okJson('buy 100 bitcoin'))
eq(await transcribePcm(PCM, 'gsk_test'), '', 'direct kosong: transcript kosong, bukan gagal')
eq(calls.length, 1, 'direct kosong: proxy tidak dipanggil')

// 6. Direct gagal + proxy juga gagal -> null
reset(PROXY)
behavior = (url) => (url.includes('api.groq.com') ? (() => { throw new Error('down') })() : errStatus(502))
eq(await transcribePcm(PCM, 'gsk_test'), null, 'proxy gagal juga -> null')
eq(calls.length, 2, 'proxy gagal juga: fetch 2x')

// 7. Normalisasi URL proxy
reset('https://polyglance-watcher.test.workers.dev/stt/')
eq(getSttProxyUrl(), PROXY, 'trailing slash dibuang')
reset('https://polyglance-watcher.test.workers.dev')
eq(getSttProxyUrl(), PROXY, 'tanpa /stt -> ditambah')
reset('not-a-url')
eq(getSttProxyUrl(), null, 'bukan URL -> null')
reset('')
eq(getSttProxyUrl(), null, 'kosong -> null (proxy mati)')
reset('   https://polyglance-watcher.test.workers.dev/stt   ')
eq(getSttProxyUrl(), PROXY, 'spasi di ujung dibuang')

console.log(`stt-fallback: ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
