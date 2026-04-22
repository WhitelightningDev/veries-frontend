import { useEffect, useMemo, useRef, useState } from 'react'
import { loadOpenCv } from '../lib/openCv'

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

type CropRect = { x: number; y: number; width: number; height: number }

const OVERLAY_GEOMETRY = {
  document: {
    cutout: { x: 12, y: 30, width: 76, height: 48, radius: 5 },
    crop: { x: 0.12, y: 0.3, width: 0.76, height: 0.48 } satisfies CropRect,
  },
  face: {
    oval: { cx: 44, cy: 44, rx: 20, ry: 27 },
    eyeLineY: 38,
    idHint: { x: 60, y: 57, width: 30, height: 20, radius: 4 },
  },
} as const

const DOCUMENT_TARGET_ASPECT =
  OVERLAY_GEOMETRY.document.crop.width / OVERLAY_GEOMETRY.document.crop.height

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function rectLerp(a: CropRect, b: CropRect, t: number): CropRect {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    width: lerp(a.width, b.width, t),
    height: lerp(a.height, b.height, t),
  }
}

type Point = { x: number; y: number }
type Quad = [Point, Point, Point, Point]

function pointLerp(a: Point, b: Point, t: number): Point {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }
}

function quadLerp(a: Quad, b: Quad, t: number): Quad {
  return [
    pointLerp(a[0], b[0], t),
    pointLerp(a[1], b[1], t),
    pointLerp(a[2], b[2], t),
    pointLerp(a[3], b[3], t),
  ]
}

function dist(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function orderQuadPoints(points: Point[]): Quad | null {
  if (points.length !== 4) return null
  const sums = points.map((p) => p.x + p.y)
  const diffs = points.map((p) => p.x - p.y)

  const tl = points[sums.indexOf(Math.min(...sums))]
  const br = points[sums.indexOf(Math.max(...sums))]
  const tr = points[diffs.indexOf(Math.min(...diffs))]
  const bl = points[diffs.indexOf(Math.max(...diffs))]

  return [tl, tr, br, bl]
}

function quadBoundingRect(quad: Quad): CropRect {
  const xs = quad.map((p) => p.x)
  const ys = quad.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return normalizeRect({
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  })
}

function normalizeRect(rect: CropRect): CropRect {
  const x = clamp(rect.x, 0, 1)
  const y = clamp(rect.y, 0, 1)
  const width = clamp(rect.width, 0.05, 1 - x)
  const height = clamp(rect.height, 0.05, 1 - y)
  return { x, y, width, height }
}

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
  const documentDetectCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const documentCaptureCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const documentWarpCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const sessionIdRef = useRef<string>(createSessionId())

  const [step, setStep] = useState<FlowStep>('document_live')
  const [faceDataUrl, setFaceDataUrl] = useState<string | null>(null)
  const [documentDataUrl, setDocumentDataUrl] = useState<string | null>(null)
  const [documentDetectRect, setDocumentDetectRect] = useState<CropRect | null>(
    null,
  )
  const documentDetectRectRef = useRef<CropRect | null>(null)
  const [documentDetectQuad, setDocumentDetectQuad] = useState<Quad | null>(
    null,
  )
  const documentDetectQuadRef = useRef<Quad | null>(null)
  const documentDetectConfidenceRef = useRef<number>(0)
  const cvRef = useRef<any | null>(null)
  const [cvStatus, setCvStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle')

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
          'Keep your eyes near the dashed line.',
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

  async function handleConfirmSubmission() {
    if (!faceDataUrl || !documentDataUrl) return
    if (submitState.status === 'submitting') return

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
      setStep('success')
      void stopCamera()
    } catch (error) {
      trackEvent('submission_failed', {
        message:
          error instanceof Error ? error.message : 'Submission failed.',
      })
      setSubmitState({
        status: 'error',
        message:
          error instanceof Error ? error.message : 'Submission failed.',
      })
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
    }
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
      let settled = false
      let timeoutId: number | null = null

      const finalize = () => {
        if (settled) return
        settled = true
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId)
        }
        recorder.removeEventListener('stop', onStop)
        stopRecordingPromiseRef.current = null

        const blob = recordedBlobRef.current
        if (blob) {
          setRecordingState({ status: 'stopped', blob })
        } else {
          setRecordingState({ status: 'idle' })
        }
        resolve(blob)
      }

      const onStop = () => finalize()

      recorder.addEventListener('stop', onStop)

      timeoutId = window.setTimeout(() => {
        finalize()
      }, 2500)

      try {
        recorder.stop()
      } catch {
        finalize()
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

    const crop =
      mode === 'document'
        ? (documentDetectRectRef.current ?? OVERLAY_GEOMETRY.document.crop)
        : null
    const sx = crop ? Math.round(crop.x * width) : 0
    const sy = crop ? Math.round(crop.y * height) : 0
    const sw = crop ? Math.round(crop.width * width) : width
    const sh = crop ? Math.round(crop.height * height) : height

    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh

    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0)
      ctx.scale(-1, 1)
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh)
    } else {
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh)
    }
    return canvas.toDataURL('image/jpeg', 0.92)
  }

  function captureDocumentWithWarp(): string | null {
    const cv = cvRef.current
    const quad = documentDetectQuadRef.current
    const video = videoRef.current
    if (!cv || !quad || !video) return null
    if (
      typeof cv.imread !== 'function' ||
      typeof cv.getPerspectiveTransform !== 'function' ||
      typeof cv.warpPerspective !== 'function'
    ) {
      return null
    }

    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) return null

    const frameCanvas =
      documentCaptureCanvasRef.current ?? document.createElement('canvas')
    documentCaptureCanvasRef.current = frameCanvas
    frameCanvas.width = width
    frameCanvas.height = height
    const frameCtx = frameCanvas.getContext('2d')
    if (!frameCtx) return null

    frameCtx.save()
    if (facingMode === 'user') {
      frameCtx.translate(width, 0)
      frameCtx.scale(-1, 1)
    }
    frameCtx.drawImage(video, 0, 0, width, height)
    frameCtx.restore()

    const pix = (p: Point) => ({ x: p.x * width, y: p.y * height })
    const tl = pix(quad[0])
    const tr = pix(quad[1])
    const br = pix(quad[2])
    const bl = pix(quad[3])

    const topW = Math.hypot(tr.x - tl.x, tr.y - tl.y)
    const botW = Math.hypot(br.x - bl.x, br.y - bl.y)
    const leftH = Math.hypot(bl.x - tl.x, bl.y - tl.y)
    const rightH = Math.hypot(br.x - tr.x, br.y - tr.y)
    const maxWidth = Math.max(topW, botW)
    const maxHeight = Math.max(leftH, rightH)

    let dstW = Math.round(maxWidth)
    dstW = clamp(dstW, 720, 1400)
    let dstH = Math.round(dstW / DOCUMENT_TARGET_ASPECT)
    if (dstH > maxHeight * 1.35) {
      dstH = Math.round(maxHeight)
      dstW = Math.round(dstH * DOCUMENT_TARGET_ASPECT)
    }
    dstH = clamp(dstH, 420, 1000)

    const outCanvas =
      documentWarpCanvasRef.current ?? document.createElement('canvas')
    documentWarpCanvasRef.current = outCanvas

    let srcMat: any
    let dstMat: any
    let srcPts: any
    let dstPts: any
    let m: any
    try {
      srcMat = cv.imread(frameCanvas)
      dstMat = new cv.Mat()
      srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
        tl.x,
        tl.y,
        tr.x,
        tr.y,
        br.x,
        br.y,
        bl.x,
        bl.y,
      ])
      dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0,
        0,
        dstW,
        0,
        dstW,
        dstH,
        0,
        dstH,
      ])
      m = cv.getPerspectiveTransform(srcPts, dstPts)

      cv.warpPerspective(
        srcMat,
        dstMat,
        m,
        new cv.Size(dstW, dstH),
        cv.INTER_LINEAR,
        cv.BORDER_CONSTANT,
        new cv.Scalar(0, 0, 0, 0),
      )
      cv.imshow(outCanvas, dstMat)
      return outCanvas.toDataURL('image/jpeg', 0.92)
    } catch {
      return null
    } finally {
      try {
        m?.delete?.()
        srcPts?.delete?.()
        dstPts?.delete?.()
        dstMat?.delete?.()
        srcMat?.delete?.()
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  function handleCapture() {
    const dataUrl =
      mode === 'document'
        ? (captureDocumentWithWarp() ?? captureFrame())
        : captureFrame()
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
    if (!documentDetectCanvasRef.current) {
      documentDetectCanvasRef.current = document.createElement('canvas')
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
    if (typeof window === 'undefined') return
    if (
      step !== 'document_live' ||
      cameraState.status !== 'ready' ||
      mode !== 'document'
    ) {
      return
    }

    if (cvRef.current || cvStatus === 'loading' || cvStatus === 'ready') {
      return
    }

    setCvStatus('loading')
    void loadOpenCv()
      .then((cv) => {
        cvRef.current = cv
        setCvStatus('ready')
      })
      .catch((error: unknown) => {
        setCvStatus('error')
        trackEvent('opencv_load_failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      })
  }, [cameraState.status, cvStatus, mode, step])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (
      step !== 'document_live' ||
      cameraState.status !== 'ready' ||
      mode !== 'document'
    ) {
      documentDetectConfidenceRef.current = 0
      documentDetectRectRef.current = null
      documentDetectQuadRef.current = null
      setDocumentDetectRect(null)
      setDocumentDetectQuad(null)
      return
    }

    const canvas = documentDetectCanvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return

    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return

    const scanWidth = 320
    const scanHeight = 240
    canvas.width = scanWidth
    canvas.height = scanHeight

    let lastRect: CropRect | null = null
    let lastQuad: Quad | null = null
    let lastUpdateAt = 0
    let stableFrames = 0

    const scanOnce = () => {
      if (!video.videoWidth || !video.videoHeight) return

      ctx.save()
      if (facingMode === 'user') {
        ctx.translate(scanWidth, 0)
        ctx.scale(-1, 1)
      }
      ctx.drawImage(video, 0, 0, scanWidth, scanHeight)
      ctx.restore()
      const image = ctx.getImageData(0, 0, scanWidth, scanHeight)
      const data = image.data

      const cv = cvRef.current
      if (
        cvStatus === 'ready' &&
        cv &&
        typeof cv.matFromImageData === 'function'
      ) {
        try {
          const src = cv.matFromImageData(image)
          const gray = new cv.Mat()
          const blur = new cv.Mat()
          const edges = new cv.Mat()
          const contours = new cv.MatVector()
          const hierarchy = new cv.Mat()

          cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
          cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0)
          cv.Canny(blur, edges, 60, 160)
          cv.findContours(
            edges,
            contours,
            hierarchy,
            cv.RETR_LIST,
            cv.CHAIN_APPROX_SIMPLE,
          )

          let bestQuad: Quad | null = null
          let bestScore = 0

          for (let i = 0; i < contours.size(); i++) {
            const contour = contours.get(i)
            const peri = cv.arcLength(contour, true)
            const approx = new cv.Mat()
            cv.approxPolyDP(contour, approx, 0.02 * peri, true)

            if (approx.rows === 4 && cv.isContourConvex(approx)) {
              const area = cv.contourArea(approx)
              const areaNorm = area / (scanWidth * scanHeight)
              if (areaNorm > 0.12) {
                const pts: Point[] = []
                const arr = approx.data32S as Int32Array
                for (let j = 0; j < arr.length; j += 2) {
                  pts.push({
                    x: arr[j] / scanWidth,
                    y: arr[j + 1] / scanHeight,
                  })
                }
                const ordered = orderQuadPoints(pts)
                if (ordered) {
                  const topW = dist(ordered[0], ordered[1])
                  const botW = dist(ordered[3], ordered[2])
                  const leftH = dist(ordered[0], ordered[3])
                  const rightH = dist(ordered[1], ordered[2])
                  const w = (topW + botW) / 2
                  const h = (leftH + rightH) / 2
                  const aspect = w / Math.max(1e-6, h)
                  const aspectScore = clamp(
                    Math.min(
                      aspect / DOCUMENT_TARGET_ASPECT,
                      DOCUMENT_TARGET_ASPECT / aspect,
                    ),
                    0,
                    1,
                  )

                  const score = areaNorm * aspectScore
                  if (score > bestScore) {
                    bestScore = score
                    bestQuad = ordered
                  }
                }
              }
            }

            approx.delete()
            contour.delete()
          }

          hierarchy.delete()
          contours.delete()
          edges.delete()
          blur.delete()
          gray.delete()
          src.delete()

          const confidence = clamp(bestScore * 6.5, 0, 1)
          documentDetectConfidenceRef.current = confidence

          if (bestQuad && confidence >= 0.5) {
            if (lastQuad) {
              const delta = lastQuad.reduce((sum, p, idx) => {
                const next = bestQuad[idx]
                return sum + Math.abs(p.x - next.x) + Math.abs(p.y - next.y)
              }, 0)
              if (delta < 0.06) {
                stableFrames = Math.min(6, stableFrames + 1)
              } else {
                stableFrames = Math.max(0, stableFrames - 1)
              }
            } else {
              stableFrames = 1
            }

            const alpha = stableFrames >= 3 ? 0.35 : 0.22
            lastQuad = lastQuad ? quadLerp(lastQuad, bestQuad, alpha) : bestQuad
            documentDetectQuadRef.current = lastQuad
            const rectFromQuad = quadBoundingRect(lastQuad)
            documentDetectRectRef.current = rectFromQuad

            const now = Date.now()
            if (now - lastUpdateAt > 220) {
              lastUpdateAt = now
              setDocumentDetectQuad(lastQuad)
              setDocumentDetectRect(rectFromQuad)
            }
            return
          }

          // If OpenCV is ready but we don't have a stable quad, clear it and fall back.
          if (confidence < 0.25) {
            lastQuad = null
            documentDetectQuadRef.current = null
            setDocumentDetectQuad(null)
          }
        } catch {
          // Fall back to heuristic detection below.
        }
      }

      const gray = new Uint8ClampedArray(scanWidth * scanHeight)
      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        gray[p] =
          (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0
      }

      const colSum = new Float32Array(scanWidth)
      const rowSum = new Float32Array(scanHeight)

      const yBandStart = Math.floor(scanHeight * 0.22)
      const yBandEnd = Math.floor(scanHeight * 0.86)
      const xBandStart = Math.floor(scanWidth * 0.1)
      const xBandEnd = Math.floor(scanWidth * 0.9)

      for (let y = 1; y < scanHeight - 1; y++) {
        const yOffset = y * scanWidth
        for (let x = 1; x < scanWidth - 1; x++) {
          const idx = yOffset + x
          const v = Math.abs(gray[idx + 1] - gray[idx - 1])
          const h = Math.abs(gray[idx + scanWidth] - gray[idx - scanWidth])
          const mag = v + h

          if (y >= yBandStart && y <= yBandEnd) {
            colSum[x] += v
          }
          if (x >= xBandStart && x <= xBandEnd) {
            rowSum[y] += h
          }
        }
      }

      const argmax = (arr: Float32Array, start: number, end: number) => {
        let best = start
        let bestVal = -Infinity
        for (let i = start; i <= end; i++) {
          const val = arr[i]
          if (val > bestVal) {
            bestVal = val
            best = i
          }
        }
        return { index: best, value: bestVal }
      }

      const mean = (arr: Float32Array) => {
        let sum = 0
        for (const value of arr) sum += value
        return sum / arr.length
      }

      const meanCol = Math.max(1, mean(colSum))
      const meanRow = Math.max(1, mean(rowSum))

      const left = argmax(
        colSum,
        Math.floor(scanWidth * 0.06),
        Math.floor(scanWidth * 0.44),
      )
      const right = argmax(
        colSum,
        Math.floor(scanWidth * 0.56),
        Math.floor(scanWidth * 0.94),
      )
      const top = argmax(
        rowSum,
        Math.floor(scanHeight * 0.12),
        Math.floor(scanHeight * 0.5),
      )
      const bottom = argmax(
        rowSum,
        Math.floor(scanHeight * 0.55),
        Math.floor(scanHeight * 0.96),
      )

      const widthPx = right.index - left.index
      const heightPx = bottom.index - top.index
      if (widthPx < scanWidth * 0.35 || heightPx < scanHeight * 0.2) {
        documentDetectConfidenceRef.current = Math.max(
          0,
          documentDetectConfidenceRef.current - 0.08,
        )
        stableFrames = 0
        return
      }

      const raw: CropRect = {
        x: left.index / scanWidth,
        y: top.index / scanHeight,
        width: widthPx / scanWidth,
        height: heightPx / scanHeight,
      }

      const aspect = raw.width / Math.max(1e-6, raw.height)
      const aspectScore = clamp(
        Math.min(
          aspect / DOCUMENT_TARGET_ASPECT,
          DOCUMENT_TARGET_ASPECT / aspect,
        ),
        0,
        1,
      )

      const edgeScore =
        (left.value / meanCol +
          right.value / meanCol +
          top.value / meanRow +
          bottom.value / meanRow) /
        4

      const confidence = clamp(((edgeScore - 2.2) / 2.4) * aspectScore, 0, 1)
      documentDetectConfidenceRef.current = confidence

      if (confidence < 0.45) {
        stableFrames = 0
        return
      }

      // Pad a touch outward and enforce target aspect ratio around center.
      const pad = 0.02
      let rect = normalizeRect({
        x: raw.x - pad,
        y: raw.y - pad,
        width: raw.width + pad * 2,
        height: raw.height + pad * 2,
      })

      const cx = rect.x + rect.width / 2
      const cy = rect.y + rect.height / 2
      const desiredHeight = rect.width / DOCUMENT_TARGET_ASPECT
      if (Math.abs(desiredHeight - rect.height) / rect.height > 0.08) {
        rect = normalizeRect({
          x: rect.x,
          y: cy - desiredHeight / 2,
          width: rect.width,
          height: desiredHeight,
        })
      }

      if (lastRect) {
        const dx = Math.abs(rect.x - lastRect.x) + Math.abs(rect.y - lastRect.y)
        const ds =
          Math.abs(rect.width - lastRect.width) +
          Math.abs(rect.height - lastRect.height)
        if (dx + ds < 0.03) {
          stableFrames = Math.min(6, stableFrames + 1)
        } else {
          stableFrames = Math.max(0, stableFrames - 1)
        }
      } else {
        stableFrames = 1
      }

      const alpha = stableFrames >= 3 ? 0.35 : 0.22
      lastRect = lastRect ? rectLerp(lastRect, rect, alpha) : rect
      documentDetectRectRef.current = lastRect

      const now = Date.now()
      if (now - lastUpdateAt > 220) {
        lastUpdateAt = now
        setDocumentDetectRect(lastRect)
      }
    }

    const id = window.setInterval(scanOnce, 220)
    return () => window.clearInterval(id)
  }, [cameraState.status, cvStatus, facingMode, mode, step])

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

  const activeStep =
    step === 'document_live' || step === 'document_preview'
      ? 'document'
      : step === 'face_live' || step === 'face_preview'
        ? 'selfie'
        : step === 'review'
          ? 'review'
          : null

  const stepper = (
    <div className="w-full max-w-full overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
      <nav aria-label="Verification steps" className="w-max sm:w-auto">
        <ol className="flex items-center gap-3 sm:gap-4">
          <li className="flex items-center gap-3">
            <button
              type="button"
              onClick={() =>
                setStep(documentComplete ? 'document_preview' : 'document_live')
              }
              aria-current={activeStep === 'document' ? 'step' : undefined}
              className="group inline-flex items-center gap-2 text-left"
            >
              <span
                className={[
                  'grid h-8 w-8 place-items-center rounded-full border text-sm font-semibold transition',
                  activeStep === 'document'
                    ? 'border-[var(--lagoon)] bg-[var(--lagoon)] text-white'
                    : documentComplete
                      ? 'border-[var(--lagoon)] bg-[var(--accent-soft)] text-[var(--lagoon-deep)]'
                      : 'border-[var(--chip-line)] bg-[var(--chip-bg)] text-[var(--sea-ink-soft)] group-hover:text-[var(--sea-ink)]',
                ].join(' ')}
              >
                1
              </span>
              <span
                className={[
                  'text-sm font-semibold transition',
                  activeStep === 'document' || documentComplete
                    ? 'text-[var(--sea-ink)]'
                    : 'text-[var(--sea-ink-soft)] group-hover:text-[var(--sea-ink)]',
                ].join(' ')}
              >
                Document
              </span>
            </button>
          </li>

          <li
            aria-hidden="true"
            className={[
              'h-[2px] w-10 rounded-full sm:w-14',
              documentComplete
                ? 'bg-[linear-gradient(90deg,var(--lagoon),#75b5ff)]'
                : 'bg-[var(--line)]',
            ].join(' ')}
          />

          <li className="flex items-center gap-3">
            <button
              type="button"
              onClick={() =>
                documentComplete
                  ? setStep(faceComplete ? 'face_preview' : 'face_live')
                  : undefined
              }
              disabled={!documentComplete}
              aria-current={activeStep === 'selfie' ? 'step' : undefined}
              className="group inline-flex items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span
                className={[
                  'grid h-8 w-8 place-items-center rounded-full border text-sm font-semibold transition',
                  activeStep === 'selfie'
                    ? 'border-[var(--lagoon)] bg-[var(--lagoon)] text-white'
                    : faceComplete
                      ? 'border-[var(--lagoon)] bg-[var(--accent-soft)] text-[var(--lagoon-deep)]'
                      : 'border-[var(--chip-line)] bg-[var(--chip-bg)] text-[var(--sea-ink-soft)] group-hover:text-[var(--sea-ink)]',
                ].join(' ')}
              >
                2
              </span>
              <span
                className={[
                  'text-sm font-semibold transition',
                  activeStep === 'selfie' || faceComplete
                    ? 'text-[var(--sea-ink)]'
                    : 'text-[var(--sea-ink-soft)] group-hover:text-[var(--sea-ink)]',
                ].join(' ')}
              >
                Selfie
              </span>
            </button>
          </li>

          <li
            aria-hidden="true"
            className={[
              'h-[2px] w-10 rounded-full sm:w-14',
              faceComplete
                ? 'bg-[linear-gradient(90deg,var(--lagoon),#75b5ff)]'
                : 'bg-[var(--line)]',
            ].join(' ')}
          />

          <li className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => (reviewReady ? setStep('review') : undefined)}
              disabled={!reviewReady}
              aria-current={activeStep === 'review' ? 'step' : undefined}
              className="group inline-flex items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span
                className={[
                  'grid h-8 w-8 place-items-center rounded-full border text-sm font-semibold transition',
                  activeStep === 'review'
                    ? 'border-[var(--lagoon)] bg-[var(--lagoon)] text-white'
                    : reviewReady
                      ? 'border-[var(--lagoon)] bg-[var(--accent-soft)] text-[var(--lagoon-deep)]'
                      : 'border-[var(--chip-line)] bg-[var(--chip-bg)] text-[var(--sea-ink-soft)] group-hover:text-[var(--sea-ink)]',
                ].join(' ')}
              >
                3
              </span>
              <span
                className={[
                  'text-sm font-semibold transition',
                  activeStep === 'review' || reviewReady
                    ? 'text-[var(--sea-ink)]'
                    : 'text-[var(--sea-ink-soft)] group-hover:text-[var(--sea-ink)]',
                ].join(' ')}
              >
                Review
              </span>
            </button>
          </li>
        </ol>
      </nav>
    </div>
  )

  return (
    <section className="island-shell rise-in rounded-2xl p-4 sm:p-7">
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

        <div className="flex w-full flex-col flex-wrap items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
          {stepper}

          {step === 'face_live' || step === 'document_live' ? (
            <button
              type="button"
              onClick={() => {
                void stopCamera()
                openUploadPicker(mode)
              }}
              className="rounded-full border border-[var(--chip-line)] bg-white/60 px-4 py-2 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)]"
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
                onClick={() => void handleConfirmSubmission()}
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
                  onClick={handleCapture}
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
        <>
          <ReviewScreen
            faceDataUrl={faceDataUrl}
            documentDataUrl={documentDataUrl}
            onEditFace={() => setStep('face_preview')}
            onEditDocument={() => setStep('document_preview')}
          />

          <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--line)] bg-white/70 backdrop-blur-sm sm:hidden">
            <div className="page-wrap flex items-center justify-between gap-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
              <div className="min-w-0">
                <p className="m-0 text-[11px] font-semibold text-[var(--sea-ink)]">
                  Ready to submit
                </p>
                <p className="mt-1 mb-0 truncate text-[11px] text-[var(--sea-ink-soft)]">
                  {submitState.status === 'error'
                    ? submitState.message
                    : submitState.status === 'submitting'
                      ? 'Uploading your images…'
                      : 'Confirm both images to finish.'}
                </p>
              </div>

              <button
                type="button"
                onClick={() => void handleConfirmSubmission()}
                disabled={!reviewReady || submitState.status === 'submitting'}
                className="shrink-0 rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-5 py-2 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_var(--shadow-strong)] disabled:opacity-60"
              >
                {submitState.status === 'submitting' ? 'Uploading…' : 'Confirm'}
              </button>
            </div>
          </div>
        </>
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
        <>
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
                  <Overlay
                    mode={mode}
                    documentRect={documentDetectRect}
                    documentQuad={documentDetectQuad}
                  />
                ) : null}

                <div className="absolute left-4 top-4 rounded-full border border-[rgba(255,255,255,0.25)] bg-[rgba(15,27,31,0.55)] px-3 py-1.5 text-xs font-semibold tracking-wide text-white">
                  {mode === 'face' ? 'FACE' : 'DOCUMENT'}
                  {cameraState.status === 'ready' ? (
                    <span className="ml-2 text-white/70">
                      {facingMode === 'user' ? 'Front' : 'Back'}
                    </span>
                  ) : null}
                </div>

                <div className="absolute left-4 right-4 bottom-4 rounded-2xl border border-[rgba(255,255,255,0.18)] bg-[rgba(15,27,31,0.55)] px-3 py-2 text-left text-[11px] text-white/80 backdrop-blur-sm sm:px-4 sm:py-3 sm:text-xs">
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
                  <div className="absolute inset-0 grid place-items-center bg-[rgba(8,14,16,0.55)] px-4 text-center sm:px-6">
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
                  Wipe your camera lens and avoid reflections from overhead
                  lights for the best result.
                </p>
              </div>
            </aside>
          </div>

          {step === 'face_live' || step === 'document_live' ? (
            <div className="sticky bottom-3 mt-5 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--line)] bg-[var(--header-bg)] p-2 shadow-[0_18px_34px_var(--shadow-soft)] backdrop-blur sm:hidden">
              <button
                type="button"
                onClick={() => {
                  void stopCamera()
                  openUploadPicker(mode)
                }}
                className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink)]"
              >
                Upload
              </button>

              {cameraState.status === 'ready' ? (
                <>
                  <button
                    type="button"
                    onClick={flipCamera}
                    disabled={!canFlip}
                    className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink)] disabled:opacity-60"
                  >
                    Flip
                  </button>
                  <button
                    type="button"
                    onClick={stopCamera}
                    className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink)]"
                  >
                    Stop
                  </button>
                  <button
                    type="button"
                    onClick={handleCapture}
                    className="ml-auto rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-5 py-2 text-sm font-semibold text-[var(--lagoon-deep)]"
                  >
                    Capture
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => startCamera()}
                  disabled={cameraState.status === 'starting'}
                  className="ml-auto rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-5 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
                >
                  {cameraState.status === 'starting' ? 'Starting…' : 'Start'}
                </button>
              )}
              <div className="h-[env(safe-area-inset-bottom)] w-full" />
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

function Overlay({
  mode,
  documentRect,
  documentQuad,
}: {
  mode: CaptureMode
  documentRect?: CropRect | null
  documentQuad?: Quad | null
}) {
  const quad: Quad | null =
    documentQuad ??
    (documentRect
      ? ([
          { x: documentRect.x, y: documentRect.y },
          { x: documentRect.x + documentRect.width, y: documentRect.y },
          {
            x: documentRect.x + documentRect.width,
            y: documentRect.y + documentRect.height,
          },
          { x: documentRect.x, y: documentRect.y + documentRect.height },
        ] as const)
      : null)

  const quadView = quad
    ? (quad.map((p) => ({ x: p.x * 100, y: p.y * 100 })) as unknown as Quad)
    : null

  const quadPath = quadView
    ? `M${quadView[0].x},${quadView[0].y} L${quadView[1].x},${quadView[1].y} L${quadView[2].x},${quadView[2].y} L${quadView[3].x},${quadView[3].y} Z`
    : null

  const documentCutout = documentRect
    ? {
        x: documentRect.x * 100,
        y: documentRect.y * 100,
        width: documentRect.width * 100,
        height: documentRect.height * 100,
        radius: OVERLAY_GEOMETRY.document.cutout.radius,
      }
    : OVERLAY_GEOMETRY.document.cutout
  const faceOverlay = OVERLAY_GEOMETRY.face

  const documentPath = quadPath
    ? quadPath
    : `M${documentCutout.x},${documentCutout.y} h${documentCutout.width} v${documentCutout.height} h-${documentCutout.width} Z`
  const corner = 6
  const cornerStroke = 2.2
  const quadCornerLength = 8

  const quadCornerStrokes = quadView
    ? quadView.map((cornerPoint, index) => {
        const prev = quadView[(index + 3) % 4]
        const next = quadView[(index + 1) % 4]
        const v1 = { x: prev.x - cornerPoint.x, y: prev.y - cornerPoint.y }
        const v2 = { x: next.x - cornerPoint.x, y: next.y - cornerPoint.y }
        const len1 = Math.max(0.0001, Math.hypot(v1.x, v1.y))
        const len2 = Math.max(0.0001, Math.hypot(v2.x, v2.y))
        const p1 = {
          x: cornerPoint.x + (v1.x / len1) * quadCornerLength,
          y: cornerPoint.y + (v1.y / len1) * quadCornerLength,
        }
        const p2 = {
          x: cornerPoint.x + (v2.x / len2) * quadCornerLength,
          y: cornerPoint.y + (v2.y / len2) * quadCornerLength,
        }
        return `M${cornerPoint.x},${cornerPoint.y} L${p1.x},${p1.y} M${cornerPoint.x},${cornerPoint.y} L${p2.x},${p2.y}`
      })
    : null

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
            <ellipse
              cx={faceOverlay.oval.cx}
              cy={faceOverlay.oval.cy}
              rx={faceOverlay.oval.rx}
              ry={faceOverlay.oval.ry}
              fill="black"
            />
          ) : (
            <>
              {quadPath ? (
                <path d={quadPath} fill="black" />
              ) : (
                <rect
                  x={documentCutout.x}
                  y={documentCutout.y}
                  width={documentCutout.width}
                  height={documentCutout.height}
                  rx={documentCutout.radius}
                  fill="black"
                />
              )}
            </>
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
            cx={faceOverlay.oval.cx}
            cy={faceOverlay.oval.cy}
            rx={faceOverlay.oval.rx}
            ry={faceOverlay.oval.ry}
            fill="transparent"
            stroke="var(--lagoon)"
            strokeOpacity="0.95"
            strokeWidth="1.5"
          />
          <line
            x1={faceOverlay.oval.cx - 16}
            x2={faceOverlay.oval.cx + 16}
            y1={faceOverlay.eyeLineY}
            y2={faceOverlay.eyeLineY}
            stroke="var(--lagoon)"
            strokeOpacity="0.75"
            strokeWidth="1.2"
            strokeDasharray="3 3"
          />
          <rect
            x={faceOverlay.idHint.x}
            y={faceOverlay.idHint.y}
            width={faceOverlay.idHint.width}
            height={faceOverlay.idHint.height}
            rx={faceOverlay.idHint.radius}
            fill="transparent"
            stroke="var(--lagoon)"
            strokeOpacity="0.95"
            strokeWidth="1.2"
            strokeDasharray="3 2"
          />
        </>
      ) : (
        <>
          {quadPath ? (
            <>
              <path
                d={quadPath}
                fill="transparent"
                stroke="var(--lagoon)"
                strokeOpacity="0.95"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              {quadCornerStrokes?.map((d, index) => (
                <path
                  key={index}
                  d={d}
                  stroke="var(--lagoon)"
                  strokeOpacity="0.95"
                  strokeWidth={cornerStroke}
                  strokeLinecap="round"
                />
              ))}
            </>
          ) : (
            <>
              <rect
                x={documentCutout.x}
                y={documentCutout.y}
                width={documentCutout.width}
                height={documentCutout.height}
                rx={documentCutout.radius}
                fill="transparent"
                stroke="var(--lagoon)"
                strokeOpacity="0.9"
                strokeWidth="1.6"
              />
              {(
                [
                  {
                    x: documentCutout.x,
                    y: documentCutout.y,
                    dirX: 1,
                    dirY: 1,
                  },
                  {
                    x: documentCutout.x + documentCutout.width,
                    y: documentCutout.y,
                    dirX: -1,
                    dirY: 1,
                  },
                  {
                    x: documentCutout.x,
                    y: documentCutout.y + documentCutout.height,
                    dirX: 1,
                    dirY: -1,
                  },
                  {
                    x: documentCutout.x + documentCutout.width,
                    y: documentCutout.y + documentCutout.height,
                    dirX: -1,
                    dirY: -1,
                  },
                ] as const
              ).map((c, index) => (
                <path
                  key={index}
                  d={`M${c.x},${c.y} h${corner * c.dirX} M${c.x},${c.y} v${corner * c.dirY}`}
                  stroke="var(--lagoon)"
                  strokeOpacity="0.95"
                  strokeWidth={cornerStroke}
                  strokeLinecap="round"
                />
              ))}
            </>
          )}
          <path
            d={documentPath}
            fill="transparent"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="1"
            strokeDasharray="2 3"
          />
        </>
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
    <div className="mt-6 mb-24 grid gap-5 lg:mb-0 lg:grid-cols-2">
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
