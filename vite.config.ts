import { defineConfig, type Plugin } from 'vite';

/**
 * Keeps public/data in sync with the local CRC video maps: on `npm run dev` / `npm run build`
 * the airspace data is regenerated if the video maps changed (or the data is missing).
 * Without a CRC install (e.g. GitHub Actions) the committed data is used as is.
 */
function airspaceData(): Plugin {
  let done = false;
  return {
    name: 'zme-airspace-data',
    async buildStart() {
      if (done) return;
      done = true;
      const { buildData, isStale } = await import('./tools/build-data.ts');
      if (!isStale()) return;
      this.info?.('CRC video maps changed — rebuilding airspace data…');
      await buildData({ log: (m) => console.log(`  [data] ${m}`) });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [airspaceData()],
  // Reachable from a phone on the same Wi-Fi: open the "Network" URL Vite prints.
  server: { host: true, open: true },
  preview: { host: true },
  build: { chunkSizeWarningLimit: 1200 },
});
