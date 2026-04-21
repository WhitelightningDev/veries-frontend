import { createFileRoute } from '@tanstack/react-router'
import CameraVerifier from '../components/CameraVerifier'

export const Route = createFileRoute('/verify')({
  component: VerifyRoute,
})

function dataUrlToBlob(dataUrl: string) {
  const [header, base64] = dataUrl.split(',')
  const mime =
    header.match(/data:(.*?);base64/)?.[1] ?? 'application/octet-stream'
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return new Blob([bytes], { type: mime })
}

function VerifyRoute() {
  return (
    <main className="page-wrap px-4 pb-10 pt-10 sm:pt-14">
      <CameraVerifier
        onConfirm={async ({ sessionId, faceDataUrl, documentDataUrl, backgroundVideo }) => {
          const form = new FormData()
          form.set('session_id', sessionId)
          form.set(
            'face_image',
            new File([dataUrlToBlob(faceDataUrl)], `face_${sessionId}.jpg`, {
              type: 'image/jpeg',
            }),
          )
          form.set(
            'document_image',
            new File([dataUrlToBlob(documentDataUrl)], `document_${sessionId}.jpg`, {
              type: 'image/jpeg',
            }),
          )

          if (backgroundVideo) {
            form.set(
              'background_video',
              new File([backgroundVideo], `background_${sessionId}.webm`, {
                type: backgroundVideo.type || 'video/webm',
              }),
            )
          }

          const res = await fetch('/api/verify', {
            method: 'POST',
            body: form,
          })

          if (!res.ok) {
            const text = await res.text().catch(() => '')
            throw new Error(text || 'Upload failed.')
          }
        }}
      />
    </main>
  )
}
