import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/verify')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.formData()

        const sessionId = form.get('session_id')
        const faceImage = form.get('face_image')
        const documentImage = form.get('document_image')
        const backgroundVideo = form.get('background_video')

        const sizeOrNull = (value: FormDataEntryValue | null) => {
          if (!value) return null
          if (typeof value === 'string') return null
          return value.size
        }

        return json({
          ok: true,
          session_id: typeof sessionId === 'string' ? sessionId : null,
          received: {
            face_image_bytes: sizeOrNull(faceImage),
            document_image_bytes: sizeOrNull(documentImage),
            background_video_bytes: sizeOrNull(backgroundVideo),
          },
        })
      },
    },
  },
})
