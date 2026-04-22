import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

import {
  markSessionSubmitted,
  writeSessionAsset,
} from '../../lib/server/verifyStore'

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

        if (typeof sessionId !== 'string' || sessionId.length < 8) {
          return json(
            { ok: false, error: 'Invalid session_id' },
            { status: 400 },
          )
        }

        if (!(faceImage instanceof File) || faceImage.size === 0) {
          return json(
            { ok: false, error: 'Missing face_image' },
            { status: 400 },
          )
        }

        if (!(documentImage instanceof File) || documentImage.size === 0) {
          return json(
            { ok: false, error: 'Missing document_image' },
            { status: 400 },
          )
        }

        const backgroundFile =
          backgroundVideo instanceof File ? backgroundVideo : null

        const [faceBytes, documentBytes, backgroundBytes] = await Promise.all([
          faceImage.arrayBuffer(),
          documentImage.arrayBuffer(),
          backgroundFile ? backgroundFile.arrayBuffer() : Promise.resolve(null),
        ])

        const facePath = await writeSessionAsset(
          sessionId,
          'face.jpg',
          new Uint8Array(faceBytes),
        )
        const documentPath = await writeSessionAsset(
          sessionId,
          'document.jpg',
          new Uint8Array(documentBytes),
        )
        const backgroundPath = backgroundBytes
          ? await writeSessionAsset(
              sessionId,
              'background.webm',
              new Uint8Array(backgroundBytes),
            )
          : null

        const record = await markSessionSubmitted(sessionId, {
          face_image_bytes: faceImage.size,
          document_image_bytes: documentImage.size,
          background_video_bytes: backgroundFile ? backgroundFile.size : null,
        })

        return json({
          ok: true,
          session: {
            session_id: record.session_id,
            status: record.status,
            created_at: record.created_at,
            submitted_at: record.submitted_at,
          },
          stored: {
            face_image_path: facePath,
            document_image_path: documentPath,
            background_video_path: backgroundPath,
          },
        })
      },
    },
  },
})
