import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { brotliCompressSync, constants } from 'zlib';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Inline the (small) main CSS bundle directly into index.html as a
// <style> tag. Eliminates the CSS round trip and the brief flash of
// unstyled content firefox flagged (module scripts don't strictly
// block on preceding <link rel=stylesheet>, so even with the link
// before the script there's a visible unstyled frame). The lazy-
// loaded leaflet CSS chunk stays external — it's only fetched when a
// map renders and FOUC there is invisible (no map = no leaflet css
// usage).
const inlineMainCss = {
  name: 'inline-main-css',
  apply: 'build',
  enforce: 'post',
  transformIndexHtml: {
    order: 'post',
    handler(html, ctx) {
      // Pull the main CSS asset (the entry stylesheet that vite would
      // have linked) and replace its <link> with an inline <style>.
      const bundle = ctx.bundle || {};
      const linkRe = /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/g;
      return html.replace(linkRe, (full, href) => {
        const bundleKey = href.replace(/^.*?\/assets\//, 'assets/');
        const css = bundle[bundleKey];
        if (!css || css.type !== 'asset' || typeof css.source !== 'string') return full;
        return `<style>${css.source}</style>`;
      });
    },
  },
};

// Pre-compress text assets at build time to .br. Runs in closeBundle
// (after vite has written final files including resolved __VITE_PRELOAD__
// helpers) and reads from disk — generateBundle saw the un-resolved
// preload tokens and produced broken .br files. Express serves the .br
// when Accept-Encoding includes br; older clients fall through to
// Caddy's on-the-fly gzip.
const brotliPrecompress = {
  name: 'brotli-precompress',
  apply: 'build',
  enforce: 'post',
  closeBundle() {
    const distDir = join(process.cwd(), 'dist');
    for (const name of readdirSync(distDir, { recursive: true })) {
      if (!/\.(js|css|html|svg)$/i.test(name)) continue;
      const buf = readFileSync(join(distDir, name));
      if (buf.length < 1024) continue;
      writeFileSync(join(distDir, name) + '.br', brotliCompressSync(buf, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
      }));
    }
  },
};

export default defineConfig({
  plugins: [preact(), inlineMainCss, brotliPrecompress],
  base: '/sweeper/',
  server: {
    port: 5173,
    proxy: {
      '/sweeper/api': {
        target: 'http://localhost:20040',
        rewrite: (path) => path.replace(/^\/sweeper/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
