# PolyGlance Watcher — bot Telegram untuk alert harga

Watcher terpisah dari aplikasi kacamata: cek harga CoinGecko tiap 60 detik,
kirim pesan Telegram saat alert crossing, dan layani perintah bot
(`/start /alert /price /odds /list /remove /help /health`).
Perintah bot masuk INSTAN via webhook Telegram (bukan polling) — lihat
bagian "Mode webhook" di bawah. Token bot TIDAK PERNAH ada di repo — hanya
di Worker secret / env var.

## Arsitektur

```
CoinGecko 60 dtk ─┐
                  ├─► watcher ─► Telegram Bot API ─► HP ilham
Telegram webhook ─┘     (cron + POST /webhook)
```

Logika perintah + deteksi crossing ada di `core.mjs` (dipakai dua target):
- **Cloudflare Worker** (`worker.js` + `wrangler.toml`) — TARGET UTAMA, selalu nyala, gratis.
- **Node** (`watcher.js`) — fallback demo di Termux HP ilham.

## Deploy ke Cloudflare Worker (yang harus ilham lakukan sendiri)

Akun Cloudflare ilham sudah ada (per 26 Nov 01:21 WIB). Langkahnya:

1. **Install wrangler + login** (di Termux HP, sekali saja):
   ```
   npm install -g wrangler
   wrangler login
   ```
   (Buka link yang muncul, izinkan akses ke akun Cloudflare kamu.)
2. **Buat KV namespace untuk state:**
   ```
   wrangler kv namespace create ALERTS_KV
   ```
   Salin `id` yang dikembalikan, tempel ke `wrangler.toml` menggantikan
   `REPLACE_WITH_KV_NAMESPACE_ID`.
3. **Buat bot Telegram:** SUDAH DIBUAT ilham — username **@polyglance_alerts_bot**.
   Token bot dipegang ilham sampai deploy Worker (jangan dikirim mentah di chat;
   Max minta lewat jalur aman saat dibutuhkan).
4. **Set token sebagai Worker secret:**
   ```
   wrangler secret put POLYGLANCE_BOT_TOKEN
   ```
   (Tempel token saat diminta — token tidak tersimpan di file mana pun.)
4b. **(Opsional — untuk voice fallback) Set key Groq kedua sebagai Worker secret:**
   ```
   wrangler secret put GROQ_API_KEY
   ```
   Pakai key Groq KEDUA (testing) milik ilham — BUKAN key utama. Tanpa secret
   ini, endpoint `/stt` balas 500 dan voice tetap pakai jalur langsung saja.
   Key tidak tersimpan di file mana pun.
5. **Deploy:**
   ```
   cd watcher
   wrangler deploy
   ```
6. **Tes:** buka bot di Telegram → `/start` → `/alert btc above <harga 1% di atas harga saat ini>`
   → tunggu harga menyentuh (atau cek `/health` — balas "Watcher alive").
   Status Worker juga bisa dicek di `https://<nama-worker>.ilham-xxx.workers.dev/health`.

**Mode webhook (perintah instan, sejak 26 Nov 2026):** Worker menerima
perintah via `POST /webhook` begitu pesan masuk (jawab 200 cepat, proses di
background, dedupe update_id). Pasang sekali setelah deploy:
```
curl https://<worker>/setwebhook
# -> { ok: true, webhookInfo: { url: "https://<worker>/webhook", ... } }
```
Route `/setwebhook` hanya memasang URL tetap itu (tidak terima URL dari
parameter) jadi aman dibiarkan aktif. Cron tetap jalan tiap menit untuk
harga + alert, tapi SKIP polling `getUpdates` saat webhook aktif; kalau
webhook ternyata terhapus dari luar, cron kembali otomatis ke polling
(verifikasi `getWebhookInfo` ~1 jam sekali). Cek status:
`GET /health` (field `webhook`) dan `GET /webhookinfo` (live dari Telegram).

**Profil bot + tombol "Open PolyGlance" (sejak 26 Nov 2026):** sekali saja:
```
curl https://<worker>/setupbot
```
Route ini (pakai secret token Worker sendiri) memasang short description,
description, daftar 9 perintah (`/start /price /odds /alert /alertodds
/list /remove /health /help` — sama persis dengan yang didukung `core.mjs`),
dan menu button Web App "Open PolyGlance" ke dashboard `GET /app`
(tema putih: harga live 5 koin, candles, Fear & Greed, odds teratas,
alert aktif tanpa chatId, link Build + video + bot — TANPA link repo;
read-only, tanpa login). Verifikasi: `GET /botinfo`.

Catatan: selama webhook aktif, fallback Node (`watcher.js`) TIDAK menerima
perintah — `getUpdates` mengembalikan kosong kalau webhook terpasang. Untuk
demo Termux, hapus webhook dulu (`curl
"https://api.telegram.org/bot<TOKEN>/deleteWebhook"`).

**Balasan ramah — tidak ada lagi "Unknown command" (sejak 26 Nov 2026):**
setiap pesan masuk selalu dibalas sesuatu yang berguna (`friendlyReply()`
di `core.mjs`): perintah telanjang (`/alert`, `/alertodds`, `/remove`) dibalas
deskripsi + cara pakai + contoh; typo arah diterima (`about`→`above`,
`bellow`→`below`, `abov`→`above` — fuzzy match jarak edit ≤ 2); arah yang
benar-benar tidak dikenal dibalas koreksi + cara pakai; teks/perintah asing
dibalas deskripsi bot + ringkasan perintah. `/help` adalah GUIDE lengkap
(quick start 3 langkah, daftar perintah + contoh, tips) — bukan cuma daftar.
**Semua teks balasan bot English.**

**Balasan kaya (sejak 26 Nov 2026):** tidak ada perintah yang balasannya
tipis — `/price` 5 koin (BTC/ETH/SOL/DOGE/XRP, spot Coinbase + perubahan
24 jam + sumber + jam update), `/odds` top 5 (question lengkap, YES%,
volume 24 jam, countdown ke close, link Polymarket), `/list` semua alert
dengan nilai sekarang + jarak ke ambang + status, konfirmasi `/alert` /
`/alertodds` gema detail lengkap, `/remove` konfirmasi persis apa yang
dihapus (nomor tidak ada → tampilkan /list), `/health` (alive, last check,
harga, jumlah alert + chats, webhook, price source). Keyword `/alertodds`
mengerti alias koin (`btc` = `bitcoin`, `eth` = `ethereum`, `sol` = `solana`,
`doge` = `dogecoin`, `xrp` = `ripple`).

**`/price` live-update (sejak 26 Nov 2026):** pesan balasan `/price` terus
di-edit tiap tick cron (60 detik) selama 30 menit dengan harga fresh —
angkanya bergerak di pesan yang sama (footer: "Live — updates every 60s
for 30 min · send /price again for a fresh snapshot"). Satu pesan per chat
(`/price` baru menggantikan yang lama); berhenti setelah 30 menit atau
kalau pesannya dihapus. Scope HANYA `/price` — `/odds` tetap snapshot.
**%24h tidak pernah hilang diam-diam** (bug 26 Nov 13:16 WIB: SOL/DOGE
tanpa %24h sementara spot lolos semua — stats gagal sebagian): stats
di-retry 1x, lalu fallback candle 1h, lalu tampil "(— 24h)" dengan jelas.

**Mini App /app — tema putih + fitur (sejak 26 Nov 2026):** dashboard
read-only, mobile-first, refresh 60 detik, tanpa JS: header status (jam
update, sumber harga, status webhook), Fear & Greed Index (Alternative.me,
tanpa key), live prices 5 koin + sparkline + high/low 24 jam, top movers
24 jam, candles live (5 koin + timeframe 1h/4h/1d via `?coin=&tf=`, SVG
server-rendered, hijau naik / merah turun, OHLC candle terakhir), top 5
odds + countdown, active alerts kaya (nilai sekarang vs ambang + jarak),
links (DoraHacks Build, demo video, bot Telegram). **Link repo GitHub
sengaja TIDAK tampil di bot + Mini App** (repo tetap publik untuk
submission; yang dihapus hanya tampilannya). Kalau satu sumber data gagal,
bagiannya tampil "unavailable" kecil — halaman lain tetap jalan. Data
paper portfolio kacamata TIDAK tampil (ada di localStorage kacamata,
bukan di Worker).

## State di KV — 5 key terpisah (sejak 26 Nov 2026)

KV Cloudflare itu eventually consistent: satu tick cron yang membaca
snapshot lama lalu menyimpan ulang SELURUH blob bisa menghapus tulisan
terbaru (terbukti 26 Nov 12:28 WIB — flag webhook yang baru dipasang hilang
dalam 2 menit). Karena itu state dipecah:

- `polyglance-state-v1` (meta): offset getUpdates, chats, processedUpdateIds
- `polyglance-prices-v1`: lastPrices, lastTick, priceSource, priceError, lastOdds — ditulis HANYA oleh cron
- `polyglance-alerts-v1`: alerts, oddsAlerts
- `polyglance-webhook-v1`: flag webhook — ditulis HANYA oleh `/setwebhook` + verifikasi berkala
- `polyglance-liveprice-v1`: pesan /price live `{messages: [{chatId, messageId, sentAt}]}` — ditulis webhook (saat /price) + cron (prune/edit tiap tick)

`loadAll()` membaca kelimanya paralel; `saveChanged()` hanya menulis
bagian yang berubah vs snapshot. Migrasi dari blob lama (v1) otomatis saat
baca pertama: field lama disalin ke key baru. Perintah yang masuk via
webhook tidak lagi bisa dihapus oleh tick, dan sebaliknya.

## STT fallback proxy (voice lewat Worker kalau Groq langsung diblokir)

Latar: fetch langsung ke `api.groq.com` dari WebView kacamata bisa HANG tanpa
respons (kemungkinan Cloudflare menahan client WebKitGTK simulator — terbukti
26 Nov ~02:00 WIB; CoinGecko + Gamma dari WebView yang sama lancar, curl dari
mesin yang sama dapat 401 dalam 0,27 detik; fase 1 fetch yang sama sempat
lolos, jadi kondisinya berubah-ubah). Aplikasi sudah coba direct dulu (timeout
25 detik); kalau gagal dan proxy URL terisi di settings, otomatis pindah ke
proxy — direct sukses tidak pernah menyentuh proxy.

**Cara kerja:** Worker yang sama (`worker.js`, endpoint `POST /stt`) menerima
audio WAV (multipart, field `file`, maks 25 MB), teruskan ke Groq Whisper
(`whisper-large-v3-turbo`) pakai key dari secret `GROQ_API_KEY`, balas JSON
`{ text }`. Key tidak pernah lewat HP/kacamata.

**Setup (sekali, bareng deploy Worker di atas):**
1. `wrangler secret put GROQ_API_KEY` — tempel key Groq KEDUA (testing) ilham.
2. `wrangler deploy` (sama seperti biasa).
3. Di HP, buka halaman settings aplikasi → isi **STT proxy URL** dengan
   `https://<nama-worker>.ilham-xxx.workers.dev/stt` → Save. Kosongkan untuk
   mematikan proxy (default).

**Tes (tanpa HP):**
```
curl -X POST https://<worker>/stt -F "file=@test.wav;type=audio/wav"
# -> {"text":"..."} kalau secret + Groq benar
# -> {"error":"GROQ_API_KEY secret not set"} kalau secret belum diisi
```

## Fallback demo di Termux (tanpa Cloudflare)

```
export POLYGLANCE_BOT_TOKEN=<token dari BotFather>
node watcher/watcher.js
```
Jalan di foreground; biarkan Termux terbuka. Android Doze bisa mematikan
proses background — cukup untuk demo video + Demo Day, bukan 24/7.

## Tes logika (tanpa token, tanpa network)

```
node watcher/core.test.mjs     # 148 tes: parser, crossing, odds, rich replies, candles, SVG
node watcher/webhook.test.mjs  # 124 tes: webhook, /setwebhook, tick skip-polling,
                               # self-heal, /app (putih + candles + fitur), /setupbot, /botinfo,
                               # rich replies end-to-end, English-only, tanpa link repo
```
