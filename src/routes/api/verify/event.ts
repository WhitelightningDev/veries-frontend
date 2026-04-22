import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

import { logSessionEvent } from '../../../lib/server/verifyStore'

export const Route = createFileRoute('/api/verify/event')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as {
          session_id?: unknown
          name?: unknown
          data?: unknown
        } | null

        const sessionId =
          body && typeof body.session_id === 'string' ? body.session_id : null
        const name = body && typeof body.name === 'string' ? body.name : null
        const data =
          body && body.data && typeof body.data === 'object'
            ? (body.data as Record<string, unknown>)
            : undefined

        if (!sessionId) {
          return json(
            { ok: false, error: 'Missing session_id' },
            { status: 400 },
          )
        }

        if (!name) {
          return json({ ok: false, error: 'Missing name' }, { status: 400 })
        }

        await logSessionEvent(sessionId, name, data)

        return json({ ok: true })
      },
    },
  },
})
