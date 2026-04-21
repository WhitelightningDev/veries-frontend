import CameraVerifier from './CameraVerifier'

function dataUrlToBlob(dataUrl: string) {
  const [header, base64] = dataUrl.split(',')
  const mime =
    header.match(/data:(.*?);base64/)?.[1] ?? 'application/octet-stream'
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return new Blob([bytes], { type: mime })
}

export default function VerifyFlow() {
  return (
    <main className="page-wrap pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-8 sm:pt-14">
      <CameraVerifier
        onConfirm={async ({
          sessionId,
          faceDataUrl,
          documentDataUrl,
          backgroundVideo,
        }) => {
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
            new File(
              [dataUrlToBlob(documentDataUrl)],
              `document_${sessionId}.jpg`,
              {
                type: 'image/jpeg',
              },
            ),
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

          const payload = (await res.json().catch(() => null)) as {
            ok?: boolean
            error?: string
          } | null

          if (payload && payload.ok === false) {
            throw new Error(payload.error || 'Upload failed.')
          }
        }}
      />
    </main>
  )
}
