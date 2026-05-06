import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { brotliCompressSync, constants } from 'zlib';

// Vite injects <script type="module"> before <link rel="stylesheet">,
// which triggers Firefox's "Layout was forced before stylesheets
// loaded" warning when the bundle starts reading layout (Leaflet's
// map-init does this). Move stylesheet links above script tags.
const cssBeforeScript = {
  name: 'css-before-script',
  transformIndexHtml(html) {
    const links = [];
    const stripped = html.replace(/\s*<link[^>]+rel=["']stylesheet["'][^>]*>/g, m => (links.push(m.trim()), ''));
    if (!links.length) return html;
    return stripped.replace(/(\s*)<script\s+type="module"/, `$1${links.join('$1')}$1<script type="module"`);
  },
};

// Pre-compress text assets at build time to .br. Express serves the
// .br when Accept-Encoding includes br; older clients fall through to
// Caddy's on-the-fly gzip. Brotli quality 11 is the slowest/smallest
// preset — fine since this only runs at build.
const brotliPrecompress = {
  name: 'brotli-precompress',
  apply: 'build',
  generateBundle(_, bundle) {
    for (const [name, file] of Object.entries(bundle)) {
      if (!/\.(js|css|html|svg)$/i.test(name)) continue;
      const src = file.type === 'asset' ? file.source : file.code;
      const buf = typeof src === 'string' ? Buffer.from(src) : Buffer.from(src);
      if (buf.length < 1024) continue; // tiny files don't compress well
      const br = brotliCompressSync(buf, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
      });
      this.emitFile({ type: 'asset', fileName: name + '.br', source: br });
    }
  },
};

export default defineConfig({
  plugins: [preact(), cssBeforeScript, brotliPrecompress],
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
