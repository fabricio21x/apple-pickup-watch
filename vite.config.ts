import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src/web') } },
  server: { proxy: { '/api': `http://127.0.0.1:${process.env.PORT || 4319}` } },
  test: { exclude: [...configDefaults.exclude, '.claude/**'] },
})
