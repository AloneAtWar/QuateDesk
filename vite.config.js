import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  // 打包产物目录不监听：chokidar 对目录持有的句柄在 Windows 上会
  // 阻塞 electron-builder 重命名 win-unpacked.tmp，导致 EPERM 打包失败
  server: {
    watch: {
      ignored: ['**/release/**', '**/release-test/**', '**/dist/**', '**/zcode-db-copy/**', '**/zcode-extracted/**'],
    },
  },
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
