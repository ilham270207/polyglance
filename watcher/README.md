# PolyGlance Watcher — bot Telegram untuk alert harga

Watcher terpisah dari aplikasi kacamata: polling harga CoinGecko tiap 60 detik,
kirim pesan Telegram saat alert crossing, dan layani perintah bot
(`/start /alert /price /odds /list /remove /help /health`).
Token bot TIDAK PERNAH ada di repo — hanya di Worker secret / env var.

## Arsitektur

```
CoinGecko 60 dtk ─┐
                  ├─► watcher ─► Telegram Bot API ─► HP ilham
getUpdates 60 dtk ┘     (cron / setInterval)
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

**Opsional — mode webhook (lebih cepat dari polling):** setelah deploy, jalankan sekali:
```
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<worker>/webhook"
```
Setelah itu perintah bot masuk instan via webhook; cron tetap jalan untuk cek harga.

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
node watcher/core.test.mjs
```
