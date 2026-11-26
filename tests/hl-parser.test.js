// Unit test parser Hyperliquid PolyGlance v8 — tanpa network, tanpa SDK.
// Jalankan: node tests/hl-parser.test.js
// (meng-compile src/hl.ts dulu dengan tsc ke /tmp, lalu import hasil compile.)

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname
const outDir = mkdtempSync(join(tmpdir(), 'pg-hl-test-'))
execSync(`npx tsc src/hl.ts --outDir ${outDir} --module nodenext --target es2020 --moduleResolution nodenext --skipLibCheck`, {
  cwd: ROOT,
  stdio: 'pipe',
})
const { parseHlPerps, fmtFunding, fmtOi } = await import(
  pathToFileURL(join(outDir, 'hl.js')).href
)

let pass = 0
let fail = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; }
  else { fail++; console.log(`FAIL ${label}\n  got:      ${a}\n  expected: ${e}`) }
}
function approx(actual, expected, eps, label) {
  if (typeof actual === 'number' && Math.abs(actual - expected) <= eps) { pass++; }
  else { fail++; console.log(`FAIL ${label}\n  got:      ${actual}\n  expected: ~${expected} (+/-${eps})`) }
}

// --- fixture bentuk asli metaAndAssetCtxs ---
function fixture() {
  return [
    {
      universe: [
        { szDecimals: 5, name: 'BTC', maxLeverage: 40, marginTableId: 56 },
        { szDecimals: 5, name: 'ETH', maxLeverage: 25, marginTableId: 56 },
        { szDecimals: 3, name: 'SOL', maxLeverage: 20, marginTableId: 56 },
        { szDecimals: 2, name: 'DOGE', maxLeverage: 20, marginTableId: 56 },
      ],
      marginTables: [],
      collateralToken: 0,
    },
    [
      { funding: '0.0000008292', openInterest: '36166.9267', prevDayPx: '58867.0', markPx: '60479.0', midPx: '60485.5', oraclePx: '60516.2', dayNtlVlm: '4283800466.08', premium: '-0.000499', impactPxs: ['60485.0', '60486.0'] },
      { funding: '0.0000088088', openInterest: '646918.1612', prevDayPx: '1647.9', markPx: '1693.8', midPx: '1693.95', oraclePx: '1694.69', dayNtlVlm: '998634200.6', premium: '-0.000348', impactPxs: ['1693.9', '1694.1'] },
      { funding: '0.0000125', openInterest: '4119820.38', prevDayPx: '67.779', markPx: '70.548', midPx: '70.5485', oraclePx: '70.575', dayNtlVlm: '202060297.8', premium: '-0.000196', impactPxs: ['70.548', '70.5611'] },
      { funding: '0.00002', openInterest: '1000000', prevDayPx: '0.05', markPx: '0.0568', midPx: '0.0568', oraclePx: '0.0568', dayNtlVlm: '1000000', premium: '0', impactPxs: ['0.0568', '0.0568'] },
    ],
  ]
}

const rows = parseHlPerps(fixture())
eq(rows !== null && rows.length, 3, 'parse valid -> 3 baris')
if (rows) {
  eq(rows[0].sym, 'BTC', 'baris 0 = BTC')
  approx(rows[0].mark, 60479, 0.001, 'BTC mark')
  approx(rows[0].chg, ((60479 - 58867) / 58867) * 100, 0.001, 'BTC chg 24h')
  approx(rows[0].funding, 0.0000008292, 1e-12, 'BTC funding')
  approx(rows[0].oiUsd, 36166.9267 * 60479, 1, 'BTC OI USD')
  eq(rows[1].sym, 'ETH', 'baris 1 = ETH')
  approx(rows[1].chg, ((1693.8 - 1647.9) / 1647.9) * 100, 0.001, 'ETH chg 24h')
  eq(rows[2].sym, 'SOL', 'baris 2 = SOL')
  approx(rows[2].chg, ((70.548 - 67.779) / 67.779) * 100, 0.001, 'SOL chg 24h')
  approx(rows[2].oiUsd, 4119820.38 * 70.548, 1, 'SOL OI USD')
}

// --- payload rusak -> null (satu koin rusak = seluruh payload ditolak) ---
const noSol = fixture()
noSol[0].universe = noSol[0].universe.filter((u) => u.name !== 'SOL')
eq(parseHlPerps(noSol), null, 'SOL hilang dari universe -> null')

const badMark = fixture()
badMark[1][1].markPx = 'n/a'
eq(parseHlPerps(badMark), null, 'markPx bukan angka -> null')

const zeroPrev = fixture()
zeroPrev[1][0].prevDayPx = '0'
eq(parseHlPerps(zeroPrev), null, 'prevDayPx 0 -> null')

const negOi = fixture()
negOi[1][2].openInterest = '-5'
eq(parseHlPerps(negOi), null, 'openInterest negatif -> null')

eq(parseHlPerps(null), null, 'null -> null')
eq(parseHlPerps({}), null, 'objek bukan array -> null')
eq(parseHlPerps([{}]), null, 'array 1 elemen -> null')
eq(parseHlPerps([{ universe: [] }, []]), null, 'universe kosong -> null')
const shortCtx = fixture()
shortCtx[1] = shortCtx[1].slice(0, 2)
eq(parseHlPerps(shortCtx), null, 'ctxs lebih pendek dari index SOL -> null')

// --- format funding ---
eq(fmtFunding(0.0000125), '+0.0013%/h', 'funding SOL 0.0000125')
eq(fmtFunding(0.0000008292), '+0.0001%/h', 'funding BTC kecil')
eq(fmtFunding(-0.00001), '-0.0010%/h', 'funding negatif')
eq(fmtFunding(0), '+0.0000%/h', 'funding nol')

// --- format open interest ---
eq(fmtOi(2187000000), '$2.2B', 'OI $2.2B')
eq(fmtOi(290600000), '$291M', 'OI $291M')
eq(fmtOi(45000), '$45K', 'OI $45K')
eq(fmtOi(500), '$500', 'OI $500')

console.log(`\nhl-parser: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
