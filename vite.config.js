import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { brotliCompressSync, constants } from 'zlib';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

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
    const compress = (path) => {
      const buf = readFileSync(path);
      if (buf.length < 1024) return;
      writeFileSync(path + '.br', brotliCompressSync(buf, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
      }));
    };
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|css|html|svg)$/i.test(e.name)) compress(p);
      }
    };
    walk(distDir);
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
