import { useEffect, useMemo, useRef, useState } from 'react'

type CaptureMode = 'face' | 'document'
type FacingMode = 'user' | 'environment'
type FlowStep =
  | 'face_live'
  | 'face_preview'
  | 'document_live'
  | 'document_preview'
  | 'review'

type CameraState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'ready' }
  | { status: 'unsupported' }
  | { status: 'denied' }
  | { status: 'error'; message: string }

function getErrorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = String((error as { name?: unknown }).name)
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'denied'
    }
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Unknown camera error'
}

function getMediaDevices() {
  if (typeof window === 'undefined') return undefined
  return window.navigator.mediaDevices
}

async function listVideoInputs() {
  const mediaDevices = getMediaDevices()
  if (!mediaDevices) return []

  try {
    const devices = await mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'videoinput')
  } catch {
    return []
  }
}

export default function CameraVerifier({
  onConfirm,
}: {
  onConfirm?: (assets: { faceDataUrl: string; documentDataUrl: string }) => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [step, setStep] = useState<FlowStep>('face_live')
  const [faceDataUrl, setFaceDataUrl] = useState<string | null>(null)
  const [documentDataUrl, setDocumentDataUrl] = useState<string | null>(null)

  const mode: CaptureMode =
    step === 'face_live' || step === 'face_preview' ? 'face' : 'document'

  const [facingMode, setFacingMode] = useState<FacingMode>('environment')
  const [cameraState, setCameraState] = useState<CameraState>({ status: 'idle' })
  const [videoInputCount, setVideoInputCount] = useState<number>(0)

  const canFlip = videoInputCount > 1

  const faceComplete = Boolean(faceDataUrl)
  const documentComplete = Boolean(documentDataUrl)
  const reviewReady = faceComplete && documentComplete

  const title = mode === 'face' ? 'Face mode' : 'Document mode'
  const subtitle =
    mode === 'face'
      ? 'Align your face, then hold your ID visibly.'
      : 'Place your ID in frame so text is clear.'

  const tips = useMemo(() => {
    return mode === 'face'
      ? [
          'Align your face inside the oval.',
          'Hold your ID beside your face and keep it readable.',
          'Make sure lighting is bright and even (avoid strong backlight).',
        ]
      : [
          'Place your ID fully inside the frame.',
          'Reduce glare by tilting the card slightly.',
          'Keep text sharp and readable; hold steady.',
          'Keep all edges in shot (no cropping).',
        ]
  }, [mode])

  function detachStream() {
    const stream = streamRef.current
    streamRef.current = null
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }

  async function stopCamera() {
    detachStream()
    setCameraState({ status: 'idle' })
  }

  async function startCamera(nextFacingMode?: FacingMode) {
    const mediaDevices = getMediaDevices()
    if (!mediaDevices) {
      setCameraState({ status: 'unsupported' })
      return
    }

    const requestedFacingMode =
      nextFacingMode ??
      (cameraState.status === 'ready'
        ? facingMode
        : mode === 'face'
          ? 'user'
          : 'environment')

    setCameraState({ status: 'starting' })

    if (streamRef.current) {
      detachStream()
    }

    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: { ideal: requestedFacingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    }

    try {
      const stream = await mediaDevices.getUserMedia(constraints)
      streamRef.current = stream

      const video = videoRef.current
      if (!video) {
        setCameraState({ status: 'error', message: 'Video element not available.' })
        return
      }

      video.srcObject = stream
      await video.play().catch(() => {
        // Some browsers require a user gesture; the UI already provides one.
      })

      const inputs = await listVideoInputs()
      setVideoInputCount(inputs.length)
      setFacingMode(requestedFacingMode)
      setCameraState({ status: 'ready' })
    } catch (error) {
      const msg = getErrorMessage(error)
      if (msg === 'denied') {
        setCameraState({ status: 'denied' })
        return
      }
      setCameraState({ status: 'error', message: msg })
    }
  }

  async function flipCamera() {
    const next = facingMode === 'user' ? 'environment' : 'user'
    await startCamera(next)
  }

  function captureFrame(): string | null {
    const video = videoRef.current
    if (!video) return null

    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) return null

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    ctx.drawImage(video, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', 0.92)
  }

  function goToFaceLive() {
    setStep('face_live')
  }

  function goToDocumentLive() {
    setStep('document_live')
  }

  useEffect(() => {
    const mediaDevices = getMediaDevices()
    if (!mediaDevices) return

    void listVideoInputs().then((inputs) => setVideoInputCount(inputs.length))

    const onDeviceChange = () => {
      void listVideoInputs().then((inputs) => setVideoInputCount(inputs.length))
    }

    mediaDevices.addEventListener('devicechange', onDeviceChange)
    return () => {
      mediaDevices.removeEventListener('devicechange', onDeviceChange)
    }
  }, [])

  useEffect(() => {
    return () => {
      detachStream()
    }
  }, [])

  useEffect(() => {
    if (cameraState.status !== 'ready') return
    if (step === 'face_live' && facingMode !== 'user') {
      void startCamera('user')
      return
    }
    if (step === 'document_live' && facingMode !== 'environment') {
      void startCamera('environment')
    }
  }, [cameraState.status, facingMode, step])

  const previewOverlayCopy = useMemo(() => {
    switch (cameraState.status) {
      case 'idle':
        return {
          title: 'Camera is off',
          detail: 'Tap “Start camera” to begin.',
        }
      case 'starting':
        return {
          title: 'Requesting camera…',
          detail: 'Please allow camera access if prompted.',
        }
      case 'unsupported':
        return {
          title: 'Camera not supported',
          detail: 'Your browser does not support camera access.',
        }
      case 'denied':
        return {
          title: 'Camera permission denied',
          detail: 'Enable camera permission in your browser settings, then try again.',
        }
      case 'error':
        return {
          title: 'Camera error',
          detail: cameraState.message,
        }
      case 'ready':
        return null
    }
  }, [cameraState])

  const primaryActionLabel =
    step === 'face_live' || step === 'document_live' ? 'Capture' : null

  return (
    <section className="island-shell rise-in rounded-3xl p-5 sm:p-7">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="island-kicker mb-2">Camera verification</p>
          <h1 className="display-title m-0 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
            {step === 'review' ? 'Final review' : title}
          </h1>
          <p className="mt-2 mb-0 max-w-2xl text-sm text-[var(--sea-ink-soft)] sm:text-base">
            {step === 'review'
              ? 'Confirm both images before submission.'
              : subtitle}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] p-1 shadow-[0_8px_18px_rgba(30,90,72,0.08)]">
            <button
              type="button"
              onClick={() => setStep(faceComplete ? 'face_preview' : 'face_live')}
              className={
                step === 'face_live' || step === 'face_preview'
                  ? 'rounded-full bg-white/70 px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)]'
                  : 'rounded-full px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
              }
            >
              Face
            </button>
            <button
              type="button"
              onClick={() =>
                faceComplete
                  ? setStep(documentComplete ? 'document_preview' : 'document_live')
                  : undefined
              }
              disabled={!faceComplete}
              className={
                step === 'document_live' || step === 'document_preview' || step === 'review'
                  ? 'rounded-full bg-white/70 px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] disabled:opacity-60'
                  : 'rounded-full px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)] disabled:opacity-60'
              }
            >
              Document
            </button>
            <button
              type="button"
              onClick={() => (reviewReady ? setStep('review') : undefined)}
              disabled={!reviewReady}
              className={
                step === 'review'
                  ? 'rounded-full bg-white/70 px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] disabled:opacity-60'
                  : 'rounded-full px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)] disabled:opacity-60'
              }
            >
              Review
            </button>
          </div>

          {step === 'review' ? (
            <>
              <button
                type="button"
                onClick={() => setStep('face_preview')}
                disabled={!faceComplete}
                className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_rgba(30,90,72,0.08)] disabled:opacity-50"
              >
                Edit face
              </button>
              <button
                type="button"
                onClick={() => setStep('document_preview')}
                disabled={!documentComplete}
                className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_rgba(30,90,72,0.08)] disabled:opacity-50"
              >
                Edit document
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!faceDataUrl || !documentDataUrl) return
                  onConfirm?.({ faceDataUrl, documentDataUrl })
                }}
                disabled={!reviewReady}
                className="rounded-full border border-[rgba(50,143,151,0.35)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_rgba(30,90,72,0.10)] transition hover:-translate-y-0.5 disabled:opacity-60"
              >
                Confirm
              </button>
            </>
          ) : cameraState.status === 'ready' &&
            (step === 'face_live' || step === 'document_live') ? (
            <>
              <button
                type="button"
                onClick={flipCamera}
                disabled={!canFlip}
                title={
                  canFlip
                    ? 'Switch camera'
                    : 'This device only reports one camera.'
                }
                className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_rgba(30,90,72,0.08)] disabled:opacity-50"
              >
                Flip camera
              </button>
              <button
                type="button"
                onClick={stopCamera}
                className="rounded-full border border-[var(--chip-line)] bg-white/60 px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_rgba(30,90,72,0.08)]"
              >
                Stop
              </button>
              {primaryActionLabel ? (
                <button
                  type="button"
                  onClick={() => {
                    const dataUrl = captureFrame()
                    if (!dataUrl) {
                      setCameraState({
                        status: 'error',
                        message: 'Unable to capture a frame. Please try again.',
                      })
                      return
                    }

                    if (step === 'face_live') {
                      setFaceDataUrl(dataUrl)
                      setStep('face_preview')
                      void stopCamera()
                      return
                    }

                    setDocumentDataUrl(dataUrl)
                    setStep('document_preview')
                    void stopCamera()
                  }}
                  className="rounded-full border border-[rgba(50,143,151,0.35)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_rgba(30,90,72,0.10)] transition hover:-translate-y-0.5"
                >
                  {primaryActionLabel}
                </button>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              onClick={() => startCamera()}
              disabled={cameraState.status === 'starting'}
              className="rounded-full border border-[rgba(50,143,151,0.35)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_rgba(30,90,72,0.10)] transition hover:-translate-y-0.5 disabled:opacity-60"
            >
              {cameraState.status === 'starting' ? 'Starting…' : 'Start camera'}
            </button>
          )}
        </div>
      </header>

      {step === 'review' ? (
        <ReviewScreen
          faceDataUrl={faceDataUrl}
          documentDataUrl={documentDataUrl}
          onEditFace={() => setStep('face_preview')}
          onEditDocument={() => setStep('document_preview')}
        />
      ) : (
        <div className="mt-6 grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="relative overflow-hidden rounded-3xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--sand)_70%,black_30%)] shadow-[0_18px_44px_rgba(23,58,64,0.12)]">
            <div className="relative" style={{ aspectRatio: '4 / 5' }}>
              {step === 'face_preview' && faceDataUrl ? (
                <img
                  src={faceDataUrl}
                  alt="Captured face preview"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : step === 'document_preview' && documentDataUrl ? (
                <img
                  src={documentDataUrl}
                  alt="Captured document preview"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                <video
                  ref={videoRef}
                  className={
                    facingMode === 'user'
                      ? 'absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]'
                      : 'absolute inset-0 h-full w-full object-cover'
                  }
                  autoPlay
                  playsInline
                  muted
                />
              )}

              {step === 'face_live' || step === 'document_live' ? (
                <Overlay mode={mode} />
              ) : null}

              <div className="absolute left-4 top-4 rounded-full border border-[rgba(255,255,255,0.25)] bg-[rgba(15,27,31,0.55)] px-3 py-1.5 text-xs font-semibold tracking-wide text-white">
                {mode === 'face' ? 'FACE' : 'DOCUMENT'}
                {cameraState.status === 'ready' ? (
                  <span className="ml-2 text-white/70">
                    {facingMode === 'user' ? 'Front' : 'Back'}
                  </span>
                ) : null}
              </div>

              <div className="absolute left-4 right-4 bottom-4 rounded-2xl border border-[rgba(255,255,255,0.18)] bg-[rgba(15,27,31,0.55)] px-4 py-3 text-left text-xs text-white/80 backdrop-blur-sm">
                <p className="m-0 font-semibold text-white">
                  {mode === 'face'
                    ? 'Align your face in the oval and hold your ID visibly.'
                    : 'Keep your ID inside the frame and avoid glare.'}
                </p>
                <p className="mt-1 mb-0">
                  {mode === 'face'
                    ? 'Bright, even lighting helps. Keep both face + ID sharp.'
                    : 'Hold steady so text stays readable and edges remain visible.'}
                </p>
              </div>

              {previewOverlayCopy &&
              (step === 'face_live' || step === 'document_live') ? (
                <div className="absolute inset-0 grid place-items-center bg-[rgba(8,14,16,0.55)] px-6 text-center">
                  <div className="max-w-sm">
                    <p className="m-0 text-sm font-semibold text-white">
                      {previewOverlayCopy.title}
                    </p>
                    <p className="mt-2 mb-0 text-sm text-white/75">
                      {previewOverlayCopy.detail}
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <aside className="island-shell rounded-3xl p-5">
            <p className="island-kicker mb-2">On-screen guidance</p>
            <h2 className="m-0 text-lg font-semibold text-[var(--sea-ink)]">
              {mode === 'face' ? 'Face + ID check' : 'Document clarity check'}
            </h2>
            <ul className="mt-4 mb-0 list-disc space-y-2 pl-5 text-sm leading-6 text-[var(--sea-ink-soft)]">
              {tips.map((tip) => (
                <li key={tip}>{tip}</li>
              ))}
            </ul>

            {step === 'face_preview' || step === 'document_preview' ? (
              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (step === 'face_preview') {
                      setFaceDataUrl(null)
                      goToFaceLive()
                      void startCamera('user')
                    } else {
                      setDocumentDataUrl(null)
                      goToDocumentLive()
                      void startCamera('environment')
                    }
                  }}
                  className="rounded-full border border-[var(--chip-line)] bg-white/60 px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_rgba(30,90,72,0.08)]"
                >
                  Retake
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (step === 'face_preview') {
                      setStep('document_live')
                      void startCamera('environment')
                      return
                    }
                    setStep('review')
                    void stopCamera()
                  }}
                  className="rounded-full border border-[rgba(50,143,151,0.35)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_rgba(30,90,72,0.10)] transition hover:-translate-y-0.5"
                >
                  {step === 'face_preview'
                    ? 'Use face photo'
                    : 'Use document photo'}
                </button>
              </div>
            ) : null}

            <div className="mt-5 rounded-2xl border border-[var(--line)] bg-white/50 p-4 text-sm text-[var(--sea-ink-soft)]">
              <p className="m-0 font-semibold text-[var(--sea-ink)]">Tip</p>
              <p className="mt-1 mb-0">
                Wipe your camera lens and avoid reflections from overhead lights
                for the best result.
              </p>
            </div>
          </aside>
        </div>
      )}
    </section>
  )
}

function Overlay({ mode }: { mode: CaptureMode }) {
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <mask id={`cutout-${mode}`}>
          <rect x="0" y="0" width="100" height="100" fill="white" />
          {mode === 'face' ? (
            <ellipse cx="50" cy="44" rx="22" ry="28" fill="black" />
          ) : (
            <rect x="16" y="22" width="68" height="56" rx="6" fill="black" />
          )}
        </mask>
      </defs>

      <rect
        x="0"
        y="0"
        width="100"
        height="100"
        fill="rgba(5,12,14,0.55)"
        mask={`url(#cutout-${mode})`}
      />

      {mode === 'face' ? (
        <ellipse
          cx="50"
          cy="44"
          rx="22"
          ry="28"
          fill="transparent"
          stroke="rgba(126,211,191,0.95)"
          strokeWidth="1.5"
        />
      ) : (
        <rect
          x="16"
          y="22"
          width="68"
          height="56"
          rx="6"
          fill="transparent"
          stroke="rgba(126,211,191,0.95)"
          strokeWidth="1.5"
        />
      )}
    </svg>
  )
}

function ReviewScreen({
  faceDataUrl,
  documentDataUrl,
  onEditFace,
  onEditDocument,
}: {
  faceDataUrl: string | null
  documentDataUrl: string | null
  onEditFace: () => void
  onEditDocument: () => void
}) {
  return (
    <div className="mt-6 grid gap-5 lg:grid-cols-2">
      <div className="island-shell rounded-3xl p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="island-kicker mb-1">Face</p>
            <p className="m-0 text-sm font-semibold text-[var(--sea-ink)]">
              Face + ID preview
            </p>
          </div>
          <button
            type="button"
            onClick={onEditFace}
            className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_rgba(30,90,72,0.08)]"
          >
            Edit
          </button>
        </div>
        <div className="mt-4 overflow-hidden rounded-3xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--sand)_70%,black_30%)]">
          <div className="relative" style={{ aspectRatio: '4 / 5' }}>
            {faceDataUrl ? (
              <img
                src={faceDataUrl}
                alt="Face capture"
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-white/75">
                Missing face image
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="island-shell rounded-3xl p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="island-kicker mb-1">Document</p>
            <p className="m-0 text-sm font-semibold text-[var(--sea-ink)]">
              ID document preview
            </p>
          </div>
          <button
            type="button"
            onClick={onEditDocument}
            className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_rgba(30,90,72,0.08)]"
          >
            Edit
          </button>
        </div>
        <div className="mt-4 overflow-hidden rounded-3xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--sand)_70%,black_30%)]">
          <div className="relative" style={{ aspectRatio: '4 / 5' }}>
            {documentDataUrl ? (
              <img
                src={documentDataUrl}
                alt="Document capture"
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-white/75">
                Missing document image
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-[var(--line)] bg-white/50 p-4 text-sm text-[var(--sea-ink-soft)]">
          <p className="m-0 font-semibold text-[var(--sea-ink)]">Quick checklist</p>
          <ul className="mt-2 mb-0 list-disc space-y-1 pl-5">
            <li>Text is readable (not blurry).</li>
            <li>No glare over key details.</li>
            <li>All edges are visible.</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
