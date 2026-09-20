import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
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
