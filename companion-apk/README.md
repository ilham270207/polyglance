# PolyGlance Companion APK — v1

Aplikasi pendamping PolyGlance buat HP Android — pembeda dari rival di
hackathon Even Realities. Aplikasi kacamata (.ehpk) tetap yang utama;
APK ini pendamping di HP, bukan pengganti.

## Isi v1

APK ini shell Capacitor yang memuat Mini App live di
`https://polyglance-watcher.danham322.workers.dev/app` — jadi tidak ada
duplikasi kode: Mini App adalah satu-satunya sumber, dan update
server-side langsung terlihat di APK tanpa rebuild.

Yang tampil di v1 (sama seperti Mini App web):

- Harga live 5 koin (BTC/ETH/SOL/DOGE/XRP) + candle + ganti timeframe
- Fear & Greed index
- Odds Polymarket (top crypto markets)
- Ringkasan alert aktif
- Link: bot Telegram, build DoraHacks, video demo
- Auto-refresh tiap 60 detik (dari server)

Ikon + splash screen dari logo repo (`polyglance-logo.png`).

## Cara build (GitHub Actions — TIDAK bisa lokal)

VM ini tidak punya Java/Android SDK, jadi APK di-build di GitHub Actions:

1. Copy folder `companion-apk/` ke root repo `ilham270207/polyglance`.
2. Copy `.github/workflows/build-apk.yml` dari dalam folder ini ke
   `.github/workflows/build-apk.yml` di root repo (GitHub hanya membaca
   workflow dari root `.github/workflows/`).
3. Commit + push, ATAU buka tab **Actions → Build Companion APK →
   Run workflow** (manual).
4. Setelah run selesai, unduh artifact **`polyglance-companion-v1.apk`**
   dari halaman run tersebut (bagian Artifacts, bawah halaman).

Build memakai: Node 20, JDK 17 (Temurin), Android SDK
(`android-actions/setup-android`), `./gradlew assembleDebug`.

Catatan: `npm ci` gagal di VM ini (EPERM saat chown binari di
`node_modules` — quirk filesystem VM, bukan lockfile rusak; `npm ci`
melewati resolusi + ekstraksi paket sebelum gagal). Di runner GitHub
Actions yang fresh, `npm ci` jalan normal.

## Cara install di HP

1. Unduh `polyglance-companion-v1.apk` ke HP.
2. Buka file-nya — Android akan minta izin **"Install unknown apps"**
   buat aplikasi yang membukanya (browser / file manager). Izinkan.
3. Install, buka. **Butuh internet** — kontennya dimuat dari server.

## Yang sengaja TIDAK ada di v1

- **Push notification** — butuh Firebase Cloud Messaging + perubahan
  Worker (topik v2).
- **Voice di HP** — voice command tetap di kacamata (Groq Whisper);
  mic HP belum dihubungkan (v2).
- **Sinkron paper portfolio** — saldo paper tinggal di kacamata
  (localStorage); sinkron ke HP butuh backend baru (v2).
- **Mode offline** — WebView butuh internet; kalau offline tampil
  layar loading + link buka Mini App di browser.
- **Release build / Play Store** — yang di-build adalah **debug APK
  (unsigned)**, cukup buat demo hackathon + sideload. Rilis Play Store
  butuh signing key + build release (bukan prioritas sebelum deadline).

## Stack

- Capacitor 8.6.3 (`@capacitor/core`, `@capacitor/cli`,
  `@capacitor/android`, `@capacitor/assets`)
- appId `com.ilham270207.polyglance` (sama seperti `app.json` kacamata),
  app name `PolyGlance`
- `capacitor.config.ts` → `server.url` ke Mini App Worker
- `www/index.html` hanya fallback loading kalau WebView gagal memuat URL
