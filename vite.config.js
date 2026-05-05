import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

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

export default defineConfig({
  plugins: [preact(), cssBeforeScript],
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
