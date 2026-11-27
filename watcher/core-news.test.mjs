// Tes logika v8.4 NEWS (parse RSS) — tanpa token, tanpa network.
// Jalankan: node watcher/core-news.test.mjs
import { parseNewsHeadlines } from './core.mjs'

let pass = 0
let fail = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++ }
  else { fail++; console.log(`FAIL ${label}\n  got:      ${a}\n  expected: ${e}`) }
}

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>CoinDesk</title>
<item><title>Bitcoin Hits $100,000 for the First Time</title><link>https://example.com/1</link></item>
<item><title><![CDATA[Ethereum ETF Inflows Surge &amp; Break Records]]></title><link>https://example.com/2</link></item>
<item><title>Solana <b>Upgrade</b> Goes Live Today</title><link>https://example.com/3</link></item>
<item><title>Bitcoin Hits $100,000 for the First Time</title><link>https://example.com/1</link></item>
</channel></rss>`

eq(
  parseNewsHeadlines(SAMPLE_RSS),
  [
    'Bitcoin Hits $100,000 for the First Time',
    'Ethereum ETF Inflows Surge & Break Records',
    'Solana Upgrade Goes Live Today',
  ],
  'rss: judul item + CDATA + entity + dedupe, judul channel TIDAK ikut',
)

eq(parseNewsHeadlines(''), [], 'rss kosong -> []')
eq(parseNewsHeadlines(null), [], 'rss null -> []')
eq(parseNewsHeadlines('<rss><channel><title>Only Channel</title></channel></rss>'), [], 'rss tanpa item -> []')
eq(parseNewsHeadlines('<rss><channel><item><title>Unclosed item'), [], 'rss item tidak tertutup -> []')
eq(parseNewsHeadlines('bukan xml sama sekali'), [], 'teks acak -> []')

// Entity & numeric
eq(
  parseNewsHeadlines('<rss><channel><item><title>It&#39;s &quot;Huge&quot; &lt;News&gt;</title></item></channel></rss>'),
  [`It's "Huge" <News>`],
  'rss: entity &#39; &quot; &lt; &gt; didekode',
)
eq(
  parseNewsHeadlines('<rss><channel><item><title>  Spaced   Title   Here  </title></item></channel></rss>'),
  ['Spaced Title Here'],
  'rss: spasi berlebih dirapikan',
)

// Cap 5
const sixItems = Array.from({ length: 6 }, (_, i) => `<item><title>Headline ${i + 1}</title></item>`).join('')
eq(parseNewsHeadlines(`<rss><channel>${sixItems}</channel></rss>`).length, 5, 'rss: maks 5 judul')
eq(
  parseNewsHeadlines(`<rss><channel>${sixItems}</channel></rss>`)[4],
  'Headline 5',
  'rss: 5 judul pertama yang diambil',
)

// Item tanpa judul di-skip, judul kosong di-skip
eq(
  parseNewsHeadlines('<rss><channel><item><link>x</link></item><item><title></title></item><item><title>Real Title</title></item></channel></rss>'),
  ['Real Title'],
  'rss: item tanpa judul / judul kosong di-skip',
)

console.log(`core-news: ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
