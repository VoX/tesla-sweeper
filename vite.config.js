import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
