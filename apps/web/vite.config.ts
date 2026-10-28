import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In development the interface is served by Vite and reaches `esper serve` through this proxy;
// built, it is served by `esper serve` itself (D14).
const server = process.env.ESPER_SERVER ?? 'http://127.0.0.1:7300'

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    host: '127.0.0.1',
    // The server takes only its own origin: the proxy speaks as it.
    proxy: { '/api': { target: server, changeOrigin: true, headers: { origin: server } } },
  },
})
