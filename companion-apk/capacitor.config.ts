import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.ilham270207.polyglance',
  appName: 'PolyGlance',
  webDir: 'www',
  // The companion app is a shell: it loads the live PolyGlance Mini App
  // served by the Cloudflare Worker. No code is duplicated here — the
  // Mini App (prices, candles, Fear & Greed, Polymarket odds, alerts)
  // is the single source of truth and updates server-side.
  server: {
    url: 'https://polyglance-watcher.danham322.workers.dev/app',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
