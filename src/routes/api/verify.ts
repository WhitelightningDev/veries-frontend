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
        const selfieImage = form.get('selfie_image')
        const documentFrontImage = form.get('document_front_image')
        const documentBackImage = form.get('document_back_image')
        const backgroundVideo = form.get('background_video')

        if (typeof sessionId !== 'string' || sessionId.length < 8) {
          return json(
            { ok: false, error: 'Invalid session_id' },
            { status: 400 },
          )
        }

        if (!(selfieImage instanceof File) || selfieImage.size === 0) {
          return json(
            { ok: false, error: 'Missing selfie_image' },
            { status: 400 },
          )
        }

        if (
          !(documentFrontImage instanceof File) ||
          documentFrontImage.size === 0
        ) {
          return json(
            { ok: false, error: 'Missing document_front_image' },
            { status: 400 },
          )
        }

        if (
          !(documentBackImage instanceof File) ||
          documentBackImage.size === 0
        ) {
          return json(
            { ok: false, error: 'Missing document_back_image' },
            { status: 400 },
          )
        }

        const backgroundFile =
          backgroundVideo instanceof File ? backgroundVideo : null

        const [
          selfieBytes,
          documentFrontBytes,
          documentBackBytes,
          backgroundBytes,
        ] = await Promise.all([
          selfieImage.arrayBuffer(),
          documentFrontImage.arrayBuffer(),
          documentBackImage.arrayBuffer(),
          backgroundFile ? backgroundFile.arrayBuffer() : Promise.resolve(null),
        ])

        const selfiePath = await writeSessionAsset(
          sessionId,
          'selfie.jpg',
          new Uint8Array(selfieBytes),
        )
        const documentFrontPath = await writeSessionAsset(
          sessionId,
          'document_front.jpg',
          new Uint8Array(documentFrontBytes),
        )
        const documentBackPath = await writeSessionAsset(
          sessionId,
          'document_back.jpg',
          new Uint8Array(documentBackBytes),
        )
        const backgroundPath = backgroundBytes
          ? await writeSessionAsset(
              sessionId,
              'background.webm',
              new Uint8Array(backgroundBytes),
            )
          : null

        const record = await markSessionSubmitted(sessionId, {
          selfie_image_bytes: selfieImage.size,
          document_front_image_bytes: documentFrontImage.size,
          document_back_image_bytes: documentBackImage.size,
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
            selfie_image_path: selfiePath,
            document_front_image_path: documentFrontPath,
            document_back_image_path: documentBackPath,
            background_video_path: backgroundPath,
          },
        })
      },
    },
  },
})
