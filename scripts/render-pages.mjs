import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import app from '../dist/server/server.js'

const base = process.env.VITE_BASE ?? '/'
const baseWithSlash = base === '/' ? '/' : base.endsWith('/') ? base : `${base}/`

const origin = 'http://localhost'

const routes = [
  { urlPath: baseWithSlash, outDir: 'dist/client', outFile: 'index.html' },
  { urlPath: `${baseWithSlash}verify`, outDir: 'dist/client/verify', outFile: 'index.html' },
  { urlPath: `${baseWithSlash}about`, outDir: 'dist/client/about', outFile: 'index.html' },
]

for (const route of routes) {
  const url = new URL(route.urlPath, origin).toString()
  const res = await app.fetch(
    new Request(url, {
      headers: { accept: 'text/html' },
    }),
  )

  if (!res.ok) {
    throw new Error(`Failed to render ${route.urlPath} (status ${res.status})`)
  }

  const html = await res.text()
  await mkdir(route.outDir, { recursive: true })
  await writeFile(path.join(route.outDir, route.outFile), html, 'utf8')
}

// GitHub Pages uses Jekyll by default; disable it.
await writeFile('dist/client/.nojekyll', '', 'utf8')

// Basic fallback: show the root shell for unknown routes.
// (Refreshing deep links is handled for the routes above via their own `index.html`.)
const rootHtml = await (
  await app.fetch(new Request(new URL(baseWithSlash, origin), { headers: { accept: 'text/html' } }))
).text()
await writeFile('dist/client/404.html', rootHtml, 'utf8')

