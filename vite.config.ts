import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function normalizeBaseUrl(baseUrl?: string) {
  if (!baseUrl) return '/'
  if (baseUrl === '/') return '/'
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

const config = defineConfig({
  base: normalizeBaseUrl(process.env.VITE_BASE),
  resolve: { tsconfigPaths: true },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
  optimizeDeps: {
    // Huge UMD bundle; skipping pre-bundling keeps dev startup snappy and avoids edge-case optimizer issues.
    exclude: ['@techstark/opencv-js'],
  },
})

export default config
