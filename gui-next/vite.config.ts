import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Umbra GUI build config.
//
// Output stays inside gui-next/dist. CI copies that directory to
// /work/gui/dist in the deployment image (GUI_DIST_PATH = /work/gui/dist).
//
// /api/v1/* and /favicon.ico are proxied to the running Go backend
// during dev so cookie-based session auth works end-to-end. To point
// at a non-local backend, set VITE_API_TARGET, e.g.:
//
//   VITE_API_TARGET=http://your-server:8118 npm run dev
const apiTarget = process.env.VITE_API_TARGET || 'http://127.0.0.1:8118'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
      },
      '/health': apiTarget,
      '/favicon.ico': apiTarget,
    },
  },
})
