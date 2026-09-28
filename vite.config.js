import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        remote: fileURLToPath(new URL('./remote.html', import.meta.url)),
      },
    },
  },
  plugins: [
    react(),
    {
      name: 'electron-no-crossorigin',
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          return html.replace(/ crossorigin(?:="[^"]*")?/g, '');
        },
      },
    },
  ],
});
