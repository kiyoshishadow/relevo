import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // BACKEND_URL permite apuntar a una instancia propia del backend
        // en pruebas (p. ej. puerto 3102). Por defecto, el contratado: 3001.
        target: process.env.BACKEND_URL || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
  },
})
