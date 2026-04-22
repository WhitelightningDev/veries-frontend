import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

import {
  getOrCreateSession,
  logSessionEvent,
} from '../../../lib/server/verifyStore'

export const Route = createFileRoute('/api/verify/session')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as {
          session_id?: unknown
        } | null

        const sessionId =
          body && typeof body.session_id === 'string' ? body.session_id : null

        if (!sessionId) {
          return json(
            { ok: false, error: 'Missing session_id' },
            { status: 400 },
          )
        }

        const record = await getOrCreateSession(sessionId)
        await logSessionEvent(sessionId, 'session_started')

        return json({
          ok: true,
          session: {
            session_id: record.session_id,
            status: record.status,
            created_at: record.created_at,
          },
        })
      },
    },
  },
})
