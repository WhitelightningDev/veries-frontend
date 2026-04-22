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
          selfieDataUrl,
          documentFrontDataUrl,
          documentBackDataUrl,
          backgroundVideo,
        }) => {
          const backendBase = import.meta.env.VITE_VERIES_BACKEND_API_BASE as
            | string
            | undefined

          const normalizedBackendBase = backendBase
            ? backendBase.replace(/\/+$/, '')
            : null

          const selfieFile = new File(
            [dataUrlToBlob(selfieDataUrl)],
            `selfie_${sessionId}.jpg`,
            { type: 'image/jpeg' },
          )
          const documentFrontFile = new File(
            [dataUrlToBlob(documentFrontDataUrl)],
            `document_front_${sessionId}.jpg`,
            { type: 'image/jpeg' },
          )
          const documentBackFile = new File(
            [dataUrlToBlob(documentBackDataUrl)],
            `document_back_${sessionId}.jpg`,
            { type: 'image/jpeg' },
          )
          const backgroundFile = backgroundVideo
            ? new File([backgroundVideo], `background_${sessionId}.webm`, {
                type: backgroundVideo.type || 'video/webm',
              })
            : null

          const getCustomerId = () => {
            if (typeof window !== 'undefined') {
              const params = new URLSearchParams(window.location.search)
              const fromQuery =
                params.get('customer_id') || params.get('customerId')
              if (fromQuery) return fromQuery
            }
            const fromEnv = import.meta.env.VITE_VERIES_CUSTOMER_ID as
              | string
              | undefined
            return fromEnv || 'demo'
          }

          if (normalizedBackendBase) {
            const customerId = getCustomerId()

            const sessionRes = await fetch(
              `${normalizedBackendBase}/verification-sessions`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  client_reference: sessionId,
                  metadata: { source: 'veries-frontend' },
                }),
              },
            )

            if (!sessionRes.ok) {
              const text = await sessionRes.text().catch(() => '')
              throw new Error(text || 'Unable to start upload session.')
            }

            const sessionPayload = (await sessionRes
              .json()
              .catch(() => null)) as {
              id?: string
            } | null
            const backendSessionId = sessionPayload?.id
            if (!backendSessionId) {
              throw new Error('Backend did not return a session id.')
            }

            const uploadOne = async (assetType: string, file: File) => {
              const form = new FormData()
              form.set('customer_id', customerId)
              form.set('asset_type', assetType)
              form.set('file', file)
              const res = await fetch(
                `${normalizedBackendBase}/verification-sessions/${backendSessionId}/upload`,
                {
                  method: 'POST',
                  body: form,
                },
              )
              if (!res.ok) {
                const text = await res.text().catch(() => '')
                throw new Error(text || `Upload failed (${assetType}).`)
              }
            }

            await uploadOne('id_document_front', documentFrontFile)
            await uploadOne('id_document_back', documentBackFile)
            await uploadOne('selfie_with_id', selfieFile)
            if (backgroundFile) {
              await uploadOne('background_video', backgroundFile)
            }

            return
          }

          const localForm = new FormData()
          localForm.set('session_id', sessionId)
          localForm.set('selfie_image', selfieFile)
          localForm.set('document_front_image', documentFrontFile)
          localForm.set('document_back_image', documentBackFile)
          if (backgroundFile) {
            localForm.set('background_video', backgroundFile)
          }

          const res = await fetch('/api/verify', {
            method: 'POST',
            body: localForm,
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
