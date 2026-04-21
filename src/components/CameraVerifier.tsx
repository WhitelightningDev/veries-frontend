import { useEffect, useMemo, useRef, useState } from 'react'

type CaptureMode = 'face' | 'document'
type FacingMode = 'user' | 'environment'
type FlowStep =
  | 'face_live'
  | 'face_preview'
  | 'document_live'
  | 'document_preview'
  | 'review'
  | 'success'

type CameraState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'ready' }
  | { status: 'unsupported' }
  | { status: 'denied' }
  | { status: 'error'; message: string }

type RecordingState =
  | { status: 'idle' }
  | { status: 'recording'; startedAt: number }
  | { status: 'stopping' }
  | { status: 'stopped'; blob: Blob }
  | { status: 'unsupported' }
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

function createSessionId() {
  if (typeof globalThis !== 'undefined' && 'crypto' in globalThis) {
    const c = globalThis.crypto as Crypto | undefined
    if (c?.randomUUID) return c.randomUUID()
  }

  return `sess_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`
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
  onConfirm?: (assets: {
    sessionId: string
    faceDataUrl: string
    documentDataUrl: string
    backgroundVideo: Blob | null
  }) => void | Promise<void>
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const faceFileInputRef = useRef<HTMLInputElement | null>(null)
  const documentFileInputRef = useRef<HTMLInputElement | null>(null)

  const sessionIdRef = useRef<string>(createSessionId())

  const [step, setStep] = useState<FlowStep>('document_live')
  const [faceDataUrl, setFaceDataUrl] = useState<string | null>(null)
  const [documentDataUrl, setDocumentDataUrl] = useState<string | null>(null)

  const mode: CaptureMode =
    step === 'face_live' || step === 'face_preview' ? 'face' : 'document'

  const stepRef = useRef<FlowStep>(step)
  const modeRef = useRef<CaptureMode>(mode)
  useEffect(() => {
    stepRef.current = step
  }, [step])
  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  const [facingMode, setFacingMode] = useState<FacingMode>('environment')
  const [cameraState, setCameraState] = useState<CameraState>({
    status: 'idle',
  })
  const [videoInputCount, setVideoInputCount] = useState<number>(0)
  const [recordingState, setRecordingState] = useState<RecordingState>({
    status: 'idle',
  })
  const [submitState, setSubmitState] = useState<
    | { status: 'idle' }
    | { status: 'submitting' }
    | { status: 'submitted' }
    | { status: 'error'; message: string }
  >({ status: 'idle' })

  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingChunksRef = useRef<BlobPart[]>([])
  const recordedBlobRef = useRef<Blob | null>(null)
  const stopRecordingPromiseRef = useRef<Promise<Blob | null> | null>(null)
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0)

  const canFlip = videoInputCount > 1

  const faceComplete = Boolean(faceDataUrl)
  const documentComplete = Boolean(documentDataUrl)
  const reviewReady = faceComplete && documentComplete

  const title = mode === 'face' ? 'Face mode' : 'Document mode'
  const subtitle =
    mode === 'face'
      ? 'Align your face, then hold your ID visibly.'
      : 'Capture your ID document first, then move to the selfie step.'

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

  function trackEvent(name: string, data?: Record<string, unknown>) {
    if (typeof window === 'undefined') return

    const payload = JSON.stringify({
      session_id: sessionIdRef.current,
      name,
      ...(data ? { data } : {}),
    })

    try {
      if ('sendBeacon' in window.navigator) {
        const { sendBeacon } = window.navigator as Navigator & {
          sendBeacon: (url: string, data?: BodyInit | null) => boolean
        }
        const blob = new Blob([payload], { type: 'application/json' })
        sendBeacon('/api/verify/event', blob)
        return
      }
    } catch {
      // Fall back to fetch.
    }

    void fetch('/api/verify/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {})
  }

  function handleUploadedImage(target: CaptureMode, file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : null
      if (!result) return

      if (target === 'face') {
        setFaceDataUrl(result)
        setStep('face_preview')
        trackEvent('face_uploaded', { bytes: file.size, type: file.type })
        return
      }

      setDocumentDataUrl(result)
      setStep('document_preview')
      trackEvent('document_uploaded', { bytes: file.size, type: file.type })
    }
    reader.readAsDataURL(file)
  }

  function openUploadPicker(target: CaptureMode) {
    const input =
      target === 'face'
        ? faceFileInputRef.current
        : documentFileInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }

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
    await stopBackgroundRecording()
    detachStream()
    setCameraState({ status: 'idle' })
    trackEvent('camera_stopped')
  }

  function pickRecorderMimeType() {
    if (typeof window === 'undefined') return undefined
    const candidates = [
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm',
    ]
    for (const mimeType of candidates) {
      if (MediaRecorder.isTypeSupported(mimeType)) return mimeType
    }
    return undefined
  }

  function startBackgroundRecording(stream: MediaStream) {
    if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
      setRecordingState({ status: 'unsupported' })
      return
    }

    if (recorderRef.current && recorderRef.current.state === 'recording') {
      return
    }

    recordedBlobRef.current = null
    recordingChunksRef.current = []

    const mimeType = pickRecorderMimeType()
    try {
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 850_000,
      })

      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) return
        recordingChunksRef.current.push(event.data)
      }
      recorder.onerror = () => {
        setRecordingState({
          status: 'error',
          message: 'Background recording failed.',
        })
      }
      recorder.onstop = () => {
        const type = recorder.mimeType || 'video/webm'
        const blob = new Blob(recordingChunksRef.current, { type })
        recordedBlobRef.current = blob
        setRecordingState({ status: 'stopped', blob })
      }

      const startedAt = Date.now()
      recorder.start(1000)
      setRecordingState({ status: 'recording', startedAt })
    } catch (error) {
      setRecordingState({
        status: 'error',
        message:
          error instanceof Error ? error.message : 'Unable to start recorder.',
      })
    }
  }

  function switchCameraTrack(nextFacingMode: FacingMode) {
    const mediaDevices = getMediaDevices()
    if (!mediaDevices?.getUserMedia) {
      return Promise.reject(new Error('Camera not supported'))
    }

    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: { ideal: nextFacingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    }

    return mediaDevices.getUserMedia(constraints).then((newStream) => {
      const newTracks = newStream.getVideoTracks()
      if (newTracks.length === 0) {
        for (const t of newStream.getTracks()) t.stop()
        throw new Error('No video track available.')
      }
      const newTrack = newTracks[0]

      const existing = streamRef.current
      if (!existing) {
        streamRef.current = newStream
        if (videoRef.current) videoRef.current.srcObject = newStream
        return
      }

      const oldTracks = existing.getVideoTracks()
      if (oldTracks.length > 0) {
        const oldTrack = oldTracks[0]
        existing.removeTrack(oldTrack)
        oldTrack.stop()
      }
      existing.addTrack(newTrack)

      for (const t of newStream.getTracks()) {
        if (t !== newTrack) t.stop()
      }

      if (videoRef.current) {
        videoRef.current.srcObject = existing
      }
    })
  }

  async function stopBackgroundRecording(): Promise<Blob | null> {
    if (stopRecordingPromiseRef.current) return stopRecordingPromiseRef.current

    const recorder = recorderRef.current
    if (!recorder) {
      return recordedBlobRef.current
    }

    if (recordingState.status === 'stopped') {
      return recordingState.blob
    }

    if (recorder.state === 'inactive') {
      return recordedBlobRef.current
    }

    setRecordingState({ status: 'stopping' })
    stopRecordingPromiseRef.current = new Promise<Blob | null>((resolve) => {
      const onStop = () => {
        recorder.removeEventListener('stop', onStop)
        stopRecordingPromiseRef.current = null
        resolve(recordedBlobRef.current)
      }
      recorder.addEventListener('stop', onStop)
      try {
        recorder.stop()
      } catch {
        recorder.removeEventListener('stop', onStop)
        stopRecordingPromiseRef.current = null
        resolve(recordedBlobRef.current)
      }
    })

    return stopRecordingPromiseRef.current
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
      try {
        await switchCameraTrack(requestedFacingMode)
        setFacingMode(requestedFacingMode)
        setCameraState({ status: 'ready' })
        return
      } catch (error) {
        if (recordingState.status === 'recording') {
          setCameraState({
            status: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Unable to switch camera.',
          })
          return
        }
        detachStream()
      }
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
        setCameraState({
          status: 'error',
          message: 'Video element not available.',
        })
        return
      }

      video.srcObject = stream
      await video.play().catch(() => {
        // Some browsers require a user gesture; the UI already provides one.
      })

      if (recordingState.status === 'idle') {
        startBackgroundRecording(stream)
      }

      const inputs = await listVideoInputs()
      setVideoInputCount(inputs.length)
      setFacingMode(requestedFacingMode)
      trackEvent('camera_started', {
        facing_mode: requestedFacingMode,
        inputs: inputs.length,
      })
      setCameraState({ status: 'ready' })
    } catch (error) {
      const msg = getErrorMessage(error)
      if (msg === 'denied') {
        setCameraState({ status: 'denied' })
        trackEvent('camera_denied')
        return
      }
      setCameraState({ status: 'error', message: msg })
      trackEvent('camera_error', { message: msg })
    }
  }

  async function flipCamera() {
    const next = facingMode === 'user' ? 'environment' : 'user'
    if (streamRef.current) {
      try {
        await switchCameraTrack(next)
        setFacingMode(next)
        setCameraState({ status: 'ready' })
        return
      } catch {
        // Fall back to full restart.
      }
    }
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
      void stopBackgroundRecording()
      detachStream()
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    void fetch('/api/verify/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionIdRef.current }),
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    let wasHidden = document.hidden

    const onVisibilityChange = () => {
      const isHidden = document.hidden
      if (isHidden) {
        trackEvent('session_dropoff', {
          step: stepRef.current,
          mode: modeRef.current,
        })
      } else if (wasHidden) {
        trackEvent('session_resumed', {
          step: stepRef.current,
          mode: modeRef.current,
        })
      }
      wasHidden = isHidden
    }

    const onPageHide = () => {
      trackEvent('session_dropoff', {
        step: stepRef.current,
        mode: modeRef.current,
        reason: 'pagehide',
      })
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [])

  useEffect(() => {
    if (cameraState.status !== 'ready') return
    if (step === 'face_live' && facingMode !== 'user') {
      void flipCamera()
      return
    }
    if (step === 'document_live' && facingMode !== 'environment') {
      void flipCamera()
    }
  }, [cameraState.status, facingMode, step])

  useEffect(() => {
    if (recordingState.status !== 'recording') {
      setRecordingSeconds(0)
      return
    }

    const tick = () => {
      setRecordingSeconds(
        Math.floor((Date.now() - recordingState.startedAt) / 1000),
      )
    }
    tick()
    const id = window.setInterval(tick, 500)
    return () => window.clearInterval(id)
  }, [recordingState])

  const previewOverlayCopy = useMemo(() => {
    switch (cameraState.status) {
      case 'idle':
        return {
          title: 'Camera is off',
          detail: 'Tap “Start camera” (or upload a photo) to begin.',
        }
      case 'starting':
        return {
          title: 'Requesting camera…',
          detail: 'Please allow camera access if prompted.',
        }
      case 'unsupported':
        return {
          title: 'Camera not supported',
          detail: 'Upload a photo instead to continue.',
        }
      case 'denied':
        return {
          title: 'Camera permission denied',
          detail: 'Enable permission in settings, or upload a photo instead.',
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
    <section className="island-shell rise-in rounded-2xl p-5 sm:p-7">
      <input
        ref={documentFileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          if (!file) return
          handleUploadedImage('document', file)
        }}
      />
      <input
        ref={faceFileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          if (!file) return
          handleUploadedImage('face', file)
        }}
      />
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="island-kicker mb-2">Camera verification</p>
          <h1 className="display-title m-0 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
            {step === 'review'
              ? 'Final review'
              : step === 'success'
                ? 'Submitted'
                : title}
          </h1>
          <p className="mt-2 mb-0 max-w-2xl text-sm text-[var(--sea-ink-soft)] sm:text-base">
            {step === 'review'
              ? 'Confirm both images before submission.'
              : step === 'success'
                ? 'Verification assets uploaded successfully.'
                : subtitle}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--sea-ink-soft)]">
            {recordingState.status === 'recording' ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1">
                <span className="h-2 w-2 rounded-full bg-[linear-gradient(90deg,#0078ff,#75b5ff)]" />
                Background recording on
                <span className="text-[var(--sea-ink-soft)]/70">
                  •{' '}
                  {Math.floor(recordingSeconds / 60)
                    .toString()
                    .padStart(2, '0')}
                  :{(recordingSeconds % 60).toString().padStart(2, '0')}
                </span>
              </span>
            ) : recordingState.status === 'unsupported' ? (
              <span className="inline-flex items-center rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1">
                Background video not supported
              </span>
            ) : recordingState.status === 'error' ? (
              <span className="inline-flex items-center rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1">
                Background recording error
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1">
                Background video records during capture
              </span>
            )}

            {submitState.status === 'error' ? (
              <span className="inline-flex items-center rounded-full border border-[rgba(200,60,60,0.25)] bg-[rgba(255,255,255,0.55)] px-3 py-1 text-[rgba(140,30,30,0.9)]">
                {submitState.message}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] p-1 shadow-[0_8px_18px_var(--shadow-soft)]">
            <button
              type="button"
              onClick={() =>
                setStep(documentComplete ? 'document_preview' : 'document_live')
              }
              className={
                step === 'document_live' ||
                step === 'document_preview' ||
                step === 'review'
                  ? 'rounded-full bg-white/70 px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)]'
                  : 'rounded-full px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
              }
            >
              Document
            </button>
            <button
              type="button"
              onClick={() =>
                documentComplete
                  ? setStep(faceComplete ? 'face_preview' : 'face_live')
                  : undefined
              }
              disabled={!documentComplete}
              className={
                step === 'face_live' || step === 'face_preview'
                  ? 'rounded-full bg-white/70 px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] disabled:opacity-60'
                  : 'rounded-full px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)] disabled:opacity-60'
              }
            >
              Selfie
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

          {step === 'face_live' || step === 'document_live' ? (
            <button
              type="button"
              onClick={() => {
                void stopCamera()
                openUploadPicker(mode)
              }}
              className="rounded-full border border-[var(--chip-line)] bg-white/60 px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)]"
            >
              Upload photo
            </button>
          ) : null}

          {step === 'success' ? (
            <button
              type="button"
              onClick={async () => {
                await stopCamera()
                sessionIdRef.current = createSessionId()
                recordedBlobRef.current = null
                recordingChunksRef.current = []
                recorderRef.current = null
                setRecordingState({ status: 'idle' })
                setSubmitState({ status: 'idle' })
                setFaceDataUrl(null)
                setDocumentDataUrl(null)
                setStep('document_live')
                trackEvent('session_restart')
              }}
              className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_12px_22px_var(--shadow-strong)] transition hover:-translate-y-0.5"
            >
              Start new
            </button>
          ) : step === 'review' ? (
            <>
              <button
                type="button"
                onClick={() => setStep('document_preview')}
                disabled={!documentComplete}
                className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)] disabled:opacity-50"
              >
                Edit document
              </button>
              <button
                type="button"
                onClick={() => setStep('face_preview')}
                disabled={!faceComplete}
                className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)] disabled:opacity-50"
              >
                Edit selfie
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!faceDataUrl || !documentDataUrl) return
                  setSubmitState({ status: 'submitting' })
                  trackEvent('submission_attempted')
                  try {
                    const backgroundVideo = await stopBackgroundRecording()
                    await onConfirm?.({
                      sessionId: sessionIdRef.current,
                      faceDataUrl,
                      documentDataUrl,
                      backgroundVideo,
                    })
                    setSubmitState({ status: 'submitted' })
                    trackEvent('submission_success')
                    await stopCamera()
                    setStep('success')
                  } catch (error) {
                    trackEvent('submission_failed', {
                      message:
                        error instanceof Error
                          ? error.message
                          : 'Submission failed.',
                    })
                    setSubmitState({
                      status: 'error',
                      message:
                        error instanceof Error
                          ? error.message
                          : 'Submission failed.',
                    })
                  }
                }}
                disabled={!reviewReady || submitState.status === 'submitting'}
                className="rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_var(--shadow-strong)] transition hover:-translate-y-0.5 disabled:opacity-60"
              >
                {submitState.status === 'submitting' ? 'Uploading…' : 'Confirm'}
              </button>
            </>
          ) : cameraState.status === 'ready' && step !== 'review' ? (
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
                className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)] disabled:opacity-50"
              >
                Flip camera
              </button>
              <button
                type="button"
                onClick={stopCamera}
                className="rounded-full border border-[var(--chip-line)] bg-white/60 px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)]"
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
                      trackEvent('face_captured')
                      return
                    }

                    setDocumentDataUrl(dataUrl)
                    setStep('document_preview')
                    trackEvent('document_captured')
                  }}
                  className="rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_var(--shadow-strong)] transition hover:-translate-y-0.5"
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
              className="rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_var(--shadow-strong)] transition hover:-translate-y-0.5 disabled:opacity-60"
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
      ) : step === 'success' ? (
        <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white/50 p-6 text-[var(--sea-ink-soft)]">
          <p className="island-kicker mb-2">Success</p>
          <p className="m-0 text-sm">
            Session{' '}
            <span className="font-semibold text-[var(--sea-ink)]">
              {sessionIdRef.current}
            </span>{' '}
            is marked as submitted.
          </p>
          <p className="mt-2 mb-0 text-sm">You can safely close this page.</p>
        </div>
      ) : (
        <div className="mt-6 grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="relative overflow-hidden rounded-2xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--sand)_70%,black_30%)] shadow-[0_18px_44px_var(--shadow-deep)]">
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

          <aside className="island-shell rounded-2xl p-5">
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
                      trackEvent('face_retake')
                      goToFaceLive()
                      if (cameraState.status !== 'ready') {
                        void startCamera('user')
                      } else if (facingMode !== 'user') {
                        void flipCamera()
                      }
                    } else {
                      setDocumentDataUrl(null)
                      trackEvent('document_retake')
                      goToDocumentLive()
                      if (cameraState.status !== 'ready') {
                        void startCamera('environment')
                      } else if (facingMode !== 'environment') {
                        void flipCamera()
                      }
                    }
                  }}
                  className="rounded-full border border-[var(--chip-line)] bg-white/60 px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)]"
                >
                  Retake
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (step === 'document_preview') {
                      trackEvent('document_confirmed')
                      setStep('face_live')
                      if (cameraState.status !== 'ready') {
                        void startCamera('user')
                      } else if (facingMode !== 'user') {
                        void flipCamera()
                      }
                      return
                    }
                    trackEvent('face_confirmed')
                    setStep('review')
                  }}
                  className="rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_var(--shadow-strong)] transition hover:-translate-y-0.5"
                >
                  {step === 'document_preview'
                    ? 'Use document photo'
                    : 'Use selfie photo'}
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
        <>
          <ellipse
            cx="50"
            cy="44"
            rx="22"
            ry="28"
            fill="transparent"
            stroke="var(--lagoon)"
            strokeOpacity="0.95"
            strokeWidth="1.5"
          />
          <rect
            x="58"
            y="58"
            width="30"
            height="20"
            rx="4"
            fill="transparent"
            stroke="var(--lagoon)"
            strokeOpacity="0.95"
            strokeWidth="1.2"
            strokeDasharray="3 2"
          />
        </>
      ) : (
        <rect
          x="16"
          y="22"
          width="68"
          height="56"
          rx="6"
          fill="transparent"
          stroke="var(--lagoon)"
          strokeOpacity="0.95"
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
      <div className="island-shell rounded-2xl p-5">
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
            className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)]"
          >
            Edit
          </button>
        </div>
        <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--sand)_70%,black_30%)]">
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

      <div className="island-shell rounded-2xl p-5">
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
            className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)]"
          >
            Edit
          </button>
        </div>
        <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--sand)_70%,black_30%)]">
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
          <p className="m-0 font-semibold text-[var(--sea-ink)]">
            Quick checklist
          </p>
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
