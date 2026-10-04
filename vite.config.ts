import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 2500,
  },
  optimizeDeps: {
    include: ['@tensorflow/tfjs', '@spotify/basic-pitch', '@tonejs/midi'],
  },
})
