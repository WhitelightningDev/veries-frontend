import http from 'node:http'
import { Readable } from 'node:stream'

import app from './dist/server/server.js'

const port = Number.parseInt(process.env.PORT ?? '', 10) || 3000

function toRequest(req) {
  const method = req.method ?? 'GET'
  const host = req.headers.host ?? `localhost:${port}`
  const url = new URL(req.url ?? '/', `http://${host}`)

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'undefined') continue
    if (Array.isArray(value)) headers.set(key, value.join(', '))
    else headers.set(key, value)
  }

  const init = {
    method,
    headers,
  }

  if (method !== 'GET' && method !== 'HEAD') {
    // Node's fetch requires duplex for streamed bodies.
    // @ts-expect-error - duplex is Node-specific.
    init.duplex = 'half'
    // @ts-expect-error - IncomingMessage is a valid BodyInit in Node.
    init.body = req
  }

  return new Request(url, init)
}

async function sendNodeResponse(nodeRes, response) {
  nodeRes.statusCode = response.status

  const headers = response.headers
  const setCookies =
    typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : null

  if (setCookies && setCookies.length) {
    nodeRes.setHeader('set-cookie', setCookies)
  }

  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') continue
    nodeRes.setHeader(key, value)
  }

  if (!response.body) {
    nodeRes.end()
    return
  }

  Readable.fromWeb(response.body).pipe(nodeRes)
}

const server = http.createServer(async (req, res) => {
  try {
    const request = toRequest(req)
    const response = await app.fetch(request)
    await sendNodeResponse(res, response)
  } catch (error) {
    res.statusCode = 500
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end(error instanceof Error ? error.message : 'Internal server error')
  }
})

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Veries running on http://localhost:${port}`)
})
