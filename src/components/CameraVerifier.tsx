import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { loadOpenCv } from '../lib/openCv'

type CaptureMode = 'face' | 'document'
type FacingMode = 'user' | 'environment'
type FlowStep =
  | 'intro'
  | 'document_front_live'
  | 'document_front_preview'
  | 'document_back_live'
  | 'document_back_preview'
  | 'selfie_live'
  | 'selfie_preview'
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
type AutoCaptureState =
  | { status: 'idle' }
  | { status: 'countdown'; secondsLeft: number }
  | { status: 'capturing' }

type ImageQualityIssue =
  | 'too_small'
  | 'too_blurry'
  | 'too_dark'
  | 'too_bright'
  | 'glare_high'

type ImageQualityReport = {
  ok: boolean
  issues: ImageQualityIssue[]
  metrics: {
    width: number
    height: number
    blurVariance: number
    brightnessMean: number
    glareRatio: number
  }
}

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

function rectDelta(a: CropRect, b: CropRect) {
  return (
    Math.abs(a.x - b.x) +
    Math.abs(a.y - b.y) +
    Math.abs(a.width - b.width) +
    Math.abs(a.height - b.height)
  )
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

function quadDelta(a: Quad, b: Quad) {
  return a.reduce((sum, p, idx) => {
    const next = b[idx]
    return sum + Math.abs(p.x - next.x) + Math.abs(p.y - next.y)
  }, 0)
}

function dist(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

async function decodeDataUrlToImageData(
  dataUrl: string,
  maxSide: number,
): Promise<{ imageData: ImageData; width: number; height: number }> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('Image decoding can only run in the browser.')
  }

  const img = new Image()
  img.src = dataUrl

  if (typeof img.decode === 'function') {
    await img.decode()
  } else {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Failed to decode image.'))
    })
  }

  const width = img.naturalWidth || img.width
  const height = img.naturalHeight || img.height

  const scale =
    width && height ? Math.min(1, maxSide / Math.max(width, height)) : 1
  const outW = Math.max(1, Math.round(width * scale))
  const outH = Math.max(1, Math.round(height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    throw new Error('Unable to create canvas context.')
  }

  ctx.drawImage(img, 0, 0, outW, outH)
  const imageData = ctx.getImageData(0, 0, outW, outH)
  return { imageData, width, height }
}

function laplacianVariance(gray: Uint8ClampedArray, width: number, height: number) {
  if (width < 3 || height < 3) return 0
  let sum = 0
  let sumSq = 0
  let count = 0
  const stride = 2
  for (let y = 1; y < height - 1; y += stride) {
    const row = y * width
    for (let x = 1; x < width - 1; x += stride) {
      const idx = row + x
      const c = gray[idx]
      const lap =
        -4 * c +
        gray[idx - 1] +
        gray[idx + 1] +
        gray[idx - width] +
        gray[idx + width]
      sum += lap
      sumSq += lap * lap
      count += 1
    }
  }
  if (!count) return 0
  const mean = sum / count
  return sumSq / count - mean * mean
}

function blurVarianceWithOpenCv(imageData: ImageData, cv: any): number | null {
  if (
    !cv ||
    typeof cv.matFromImageData !== 'function' ||
    typeof cv.cvtColor !== 'function' ||
    typeof cv.Laplacian !== 'function' ||
    typeof cv.meanStdDev !== 'function'
  ) {
    return null
  }

  let src: any
  let gray: any
  let lap: any
  let mean: any
  let stddev: any
  try {
    src = cv.matFromImageData(imageData)
    gray = new cv.Mat()
    lap = new cv.Mat()
    mean = new cv.Mat()
    stddev = new cv.Mat()

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.Laplacian(gray, lap, cv.CV_64F)
    cv.meanStdDev(lap, mean, stddev)
    const s = stddev.doubleAt?.(0, 0)
    return typeof s === 'number' && Number.isFinite(s) ? s * s : null
  } catch {
    return null
  } finally {
    try {
      stddev?.delete?.()
      mean?.delete?.()
      lap?.delete?.()
      gray?.delete?.()
      src?.delete?.()
    } catch {
      // ignore
    }
  }
}

async function assessImageQuality(
  dataUrl: string,
  profile: 'document' | 'selfie',
  cv: any | null,
): Promise<ImageQualityReport> {
  const { imageData, width, height } = await decodeDataUrlToImageData(
    dataUrl,
    profile === 'document' ? 520 : 420,
  )

  const pixels = imageData.data
  const gray = new Uint8ClampedArray(imageData.width * imageData.height)
  let glareCount = 0
  let sum = 0
  for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
    const g = (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) | 0
    gray[p] = g
    sum += g
    if (g >= 250) glareCount += 1
  }
  const brightnessMean = sum / Math.max(1, gray.length)
  const glareRatio = glareCount / Math.max(1, gray.length)

  const blurVariance =
    blurVarianceWithOpenCv(imageData, cv) ??
    laplacianVariance(gray, imageData.width, imageData.height)

  const issues: ImageQualityIssue[] = []
  const minSide = Math.min(width, height)
  const minRequiredSide = profile === 'document' ? 600 : 480
  const minRequiredBlur = profile === 'document' ? 60 : 50
  const maxAllowedGlare = profile === 'document' ? 0.12 : 0.15

  if (minSide < minRequiredSide) issues.push('too_small')
  if (blurVariance < minRequiredBlur) issues.push('too_blurry')
  if (brightnessMean < 40) issues.push('too_dark')
  else if (brightnessMean > 220) issues.push('too_bright')
  if (glareRatio > maxAllowedGlare) issues.push('glare_high')

  return {
    ok: issues.length === 0,
    issues,
    metrics: {
      width,
      height,
      blurVariance,
      brightnessMean,
      glareRatio,
    },
  }
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

function faceCropInViewBox(): CropRect {
  const { oval, idHint } = OVERLAY_GEOMETRY.face
  const ovalMinX = oval.cx - oval.rx
  const ovalMaxX = oval.cx + oval.rx
  const ovalMinY = oval.cy - oval.ry
  const ovalMaxY = oval.cy + oval.ry

  const minX = Math.min(ovalMinX, idHint.x)
  const maxX = Math.max(ovalMaxX, idHint.x + idHint.width)
  const minY = Math.min(ovalMinY, idHint.y)
  const maxY = Math.max(ovalMaxY, idHint.y + idHint.height)

  const pad = 7
  return normalizeRect({
    x: (minX - pad) / 100,
    y: (minY - pad * 1.2) / 100,
    width: (maxX - minX + pad * 2) / 100,
    height: (maxY - minY + pad * 2.2) / 100,
  })
}

function mapCoverRectToVideoRect(
  video: HTMLVideoElement,
  rectInView: CropRect,
  mirrored?: boolean,
): CropRect | null {
  const bounds = video.getBoundingClientRect()
  const containerW = bounds.width
  const containerH = bounds.height
  const videoW = video.videoWidth
  const videoH = video.videoHeight
  if (!containerW || !containerH || !videoW || !videoH) return null

  const rect = mirrored
    ? {
        ...rectInView,
        x: 1 - (rectInView.x + rectInView.width),
      }
    : rectInView

  const scale = Math.max(containerW / videoW, containerH / videoH)
  const displayedW = videoW * scale
  const displayedH = videoH * scale
  const offsetX = (displayedW - containerW) / 2
  const offsetY = (displayedH - containerH) / 2

  const x = rect.x * containerW
  const y = rect.y * containerH
  const w = rect.width * containerW
  const h = rect.height * containerH

  const sx = clamp((x + offsetX) / scale, 0, videoW - 1)
  const sy = clamp((y + offsetY) / scale, 0, videoH - 1)
  const sw = clamp(w / scale, 1, videoW - sx)
  const sh = clamp(h / scale, 1, videoH - sy)

  return normalizeRect({
    x: sx / videoW,
    y: sy / videoH,
    width: sw / videoW,
    height: sh / videoH,
  })
}

function mapVideoRectToCoverRect(
  video: HTMLVideoElement,
  rectInVideo: CropRect,
  mirrored?: boolean,
): CropRect | null {
  const bounds = video.getBoundingClientRect()
  const containerW = bounds.width
  const containerH = bounds.height
  const videoW = video.videoWidth
  const videoH = video.videoHeight
  if (!containerW || !containerH || !videoW || !videoH) return null

  const scale = Math.max(containerW / videoW, containerH / videoH)
  const displayedW = videoW * scale
  const displayedH = videoH * scale
  const offsetX = (displayedW - containerW) / 2
  const offsetY = (displayedH - containerH) / 2

  const x = rectInVideo.x * videoW
  const y = rectInVideo.y * videoH
  const w = rectInVideo.width * videoW
  const h = rectInVideo.height * videoH

  const dx = x * scale - offsetX
  const dy = y * scale - offsetY
  const dw = w * scale
  const dh = h * scale

  const rect = normalizeRect({
    x: dx / containerW,
    y: dy / containerH,
    width: dw / containerW,
    height: dh / containerH,
  })
  if (!mirrored) return rect
  return {
    ...rect,
    x: 1 - (rect.x + rect.width),
  }
}

function mapVideoQuadToCoverQuad(
  video: HTMLVideoElement,
  quad: Quad,
  mirrored?: boolean,
): Quad | null {
  const bounds = video.getBoundingClientRect()
  const containerW = bounds.width
  const containerH = bounds.height
  const videoW = video.videoWidth
  const videoH = video.videoHeight
  if (!containerW || !containerH || !videoW || !videoH) return null

  const scale = Math.max(containerW / videoW, containerH / videoH)
  const displayedW = videoW * scale
  const displayedH = videoH * scale
  const offsetX = (displayedW - containerW) / 2
  const offsetY = (displayedH - containerH) / 2

  const toView = (p: Point) => {
    const dx = p.x * videoW * scale - offsetX
    const dy = p.y * videoH * scale - offsetY
    return {
      x: clamp(dx / containerW, 0, 1),
      y: clamp(dy / containerH, 0, 1),
    }
  }

  const mapped = [
    toView(quad[0]),
    toView(quad[1]),
    toView(quad[2]),
    toView(quad[3]),
  ]
  const maybeMirrored = mirrored
    ? mapped.map((p) => ({ x: 1 - p.x, y: p.y }))
    : mapped
  const ordered = orderQuadPoints(maybeMirrored)
  return ordered ?? (maybeMirrored as unknown as Quad)
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

function hasLiveVideoTrack(stream: MediaStream | null) {
  return Boolean(stream?.getVideoTracks().some((t) => t.readyState === 'live'))
}

export default function CameraVerifier({
  onConfirm,
}: {
  onConfirm?: (assets: {
    sessionId: string
    selfieDataUrl: string
    documentFrontDataUrl: string
    documentBackDataUrl: string
    backgroundVideo: Blob | null
  }) => void | Promise<void>
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const selfieFileInputRef = useRef<HTMLInputElement | null>(null)
  const documentFileInputRef = useRef<HTMLInputElement | null>(null)
  const documentDetectCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const documentCaptureCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const documentWarpCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const pendingUploadTargetRef = useRef<
    'document_front' | 'document_back' | 'selfie'
  >('document_front')

  const sessionIdRef = useRef<string>(createSessionId())
  const autoCameraStartAttemptedRef = useRef<{
    document: boolean
    face: boolean
  }>({ document: false, face: false })

  const [step, setStep] = useState<FlowStep>('intro')
  const [policiesAccepted, setPoliciesAccepted] = useState(false)
  const bypassConsent = useMemo(() => {
    if (typeof window === 'undefined') return false
    const params = new URLSearchParams(window.location.search)
    const raw =
      params.get('skip_consent') ??
      params.get('skipConsent') ??
      params.get('bypass_consent') ??
      params.get('bypassConsent')
    if (!raw) return false
    return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes'
  }, [])
  useEffect(() => {
    if (!bypassConsent) return
    setPoliciesAccepted(true)
  }, [bypassConsent])
  const [selfieDataUrl, setSelfieDataUrl] = useState<string | null>(null)
	  const [documentFrontDataUrl, setDocumentFrontDataUrl] = useState<
	    string | null
	  >(null)
	  const [documentBackDataUrl, setDocumentBackDataUrl] = useState<string | null>(
	    null,
	  )
	  const [documentFrontQuality, setDocumentFrontQuality] =
	    useState<ImageQualityReport | null>(null)
	  const [documentBackQuality, setDocumentBackQuality] =
	    useState<ImageQualityReport | null>(null)
	  const [selfieQuality, setSelfieQuality] = useState<ImageQualityReport | null>(
	    null,
	  )
	  const [documentDetectRect, setDocumentDetectRect] = useState<CropRect | null>(
	    null,
	  )
  const documentDetectRectRef = useRef<CropRect | null>(null)
  const [documentDetectQuad, setDocumentDetectQuad] = useState<Quad | null>(
    null,
  )
  const documentDetectQuadRef = useRef<Quad | null>(null)
  const documentDetectConfidenceRef = useRef<number>(0)
  const [documentDetectConfidence, setDocumentDetectConfidence] = useState(0)
  const cvRef = useRef<any | null>(null)
  const [cvStatus, setCvStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle')
  const [autoCaptureState, setAutoCaptureState] = useState<AutoCaptureState>({
    status: 'idle',
  })
  const autoCaptureStateRef = useRef<AutoCaptureState>({ status: 'idle' })
  useEffect(() => {
    autoCaptureStateRef.current = autoCaptureState
  }, [autoCaptureState])

  const mode: CaptureMode =
    step === 'selfie_live' || step === 'selfie_preview' ? 'face' : 'document'

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

  const documentFrontComplete = Boolean(documentFrontDataUrl)
  const documentBackComplete = Boolean(documentBackDataUrl)
  const selfieComplete = Boolean(selfieDataUrl)
  const reviewReady =
    documentFrontComplete && documentBackComplete && selfieComplete

  const isDocumentFrontStep =
    step === 'document_front_live' || step === 'document_front_preview'
  const isDocumentBackStep =
    step === 'document_back_live' || step === 'document_back_preview'
  const isSelfieStep = step === 'selfie_live' || step === 'selfie_preview'

  const title = isSelfieStep
    ? 'Selfie with ID'
    : isDocumentBackStep
      ? 'Back of ID'
      : 'Front of ID'
  const subtitle = isSelfieStep
    ? 'Align your face and hold your ID visibly.'
    : isDocumentBackStep
      ? 'Capture the back of your ID document.'
      : 'Capture the front of your ID document.'

  const headerKicker = step === 'intro' ? 'Verification' : 'Camera verification'
  const headerTitle =
    step === 'intro'
      ? 'Before you start'
      : step === 'review'
        ? 'Final review'
        : step === 'success'
          ? 'Submitted'
          : title
  const headerSubtitle =
    step === 'intro'
      ? 'We’ll guide you through ID front, ID back, and a selfie with your ID.'
      : step === 'review'
        ? 'Confirm all images before submission.'
        : step === 'success'
          ? 'Verification assets uploaded successfully.'
          : subtitle

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
          'Auto-capture starts once the ID is steady (3…2…1).',
        ]
  }, [mode])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (
      step !== 'document_front_live' &&
      step !== 'document_back_live' &&
      step !== 'selfie_live'
    ) {
      return
    }
    if (cameraState.status !== 'idle') return

    const key = step === 'selfie_live' ? 'face' : 'document'
    if (autoCameraStartAttemptedRef.current[key]) return
    autoCameraStartAttemptedRef.current[key] = true

    const desiredFacingMode: FacingMode =
      step === 'selfie_live' ? 'user' : 'environment'
    const id = window.setTimeout(() => {
      void startCamera(desiredFacingMode)
    }, 350)

    return () => window.clearTimeout(id)
  }, [cameraState.status, step])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const isLive =
      step === 'document_front_live' ||
      step === 'document_back_live' ||
      step === 'selfie_live'
    if (!isLive) return
    if (cameraState.status !== 'ready') return

    const stream = streamRef.current
    const video = videoRef.current
    if (!stream || !video) return
    if (video.srcObject !== stream) {
      video.srcObject = stream
      void video.play().catch(() => {})
    }
  }, [cameraState.status, step])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const isDocLive =
      step === 'document_front_live' || step === 'document_back_live'
    if (!isDocLive || cameraState.status !== 'ready') {
      if (autoCaptureStateRef.current.status !== 'idle') {
        setAutoCaptureState({ status: 'idle' })
      }
      return
    }

	    let cancelled = false
	    let stableMs = 0
	    let lastRect: CropRect | null = null
	    let lastQuad: Quad | null = null
	    let lastPollAt = window.performance.now()
	    let pollTimeoutId = 0
	    let countdownIntervalId = 0

    const clearCountdown = () => {
      if (countdownIntervalId) {
        window.clearInterval(countdownIntervalId)
        countdownIntervalId = 0
      }
    }

    const cancelCountdown = () => {
      clearCountdown()
      stableMs = 0
      if (autoCaptureStateRef.current.status !== 'idle') {
        setAutoCaptureState({ status: 'idle' })
      }
    }

	    const isStableDetection = () => {
	      const rect = documentDetectRectRef.current
	      const quad = documentDetectQuadRef.current
	      const conf = documentDetectConfidenceRef.current
	      if (conf < 0.5) {
	        lastRect = rect
	        lastQuad = quad
	        return false
	      }
	      if (quad) {
	        if (!lastQuad) {
	          lastQuad = quad
	          return true
	        }
	        const delta = quadDelta(quad, lastQuad)
	        lastQuad = quad
	        return delta < 0.08
	      }
	      if (!rect) {
	        lastRect = rect
	        lastQuad = quad
	        return false
	      }
	      if (!lastRect) {
	        lastRect = rect
	        return true
	      }
	      const delta = rectDelta(rect, lastRect)
	      lastRect = rect
	      return delta < 0.02
	    }

    const startCountdown = () => {
      if (autoCaptureStateRef.current.status !== 'idle') return
      setAutoCaptureState({ status: 'countdown', secondsLeft: 3 })
      countdownIntervalId = window.setInterval(() => {
        if (cancelled) return
        const stillDocLive =
          stepRef.current === 'document_front_live' ||
          stepRef.current === 'document_back_live'
        if (!stillDocLive) {
          cancelCountdown()
          return
        }
        if (!isStableDetection()) {
          cancelCountdown()
          return
        }

        const current = autoCaptureStateRef.current
        if (current.status !== 'countdown') return
        const next = current.secondsLeft - 1
        if (next <= 0) {
          clearCountdown()
          setAutoCaptureState({ status: 'capturing' })
          window.setTimeout(() => {
            if (cancelled) return
            const canCapture =
              stepRef.current === 'document_front_live' ||
              stepRef.current === 'document_back_live'
            if (canCapture) {
              handleCapture()
              window.setTimeout(() => {
                if (cancelled) return
                const stillLive =
                  stepRef.current === 'document_front_live' ||
                  stepRef.current === 'document_back_live'
                if (stillLive) {
                  setAutoCaptureState({ status: 'idle' })
                }
              }, 1500)
            }
          }, 80)
          return
        }
        setAutoCaptureState({ status: 'countdown', secondsLeft: next })
      }, 1000)
    }

    const poll = () => {
      if (cancelled) return
      const now = window.performance.now()
      const dt = Math.max(0, now - lastPollAt)
      lastPollAt = now

      if (autoCaptureStateRef.current.status === 'idle') {
        if (isStableDetection()) {
          stableMs += dt
        } else {
          stableMs = Math.max(0, stableMs - dt * 1.5)
        }

	        if (stableMs >= 450) {
	          startCountdown()
	        }
      } else if (autoCaptureStateRef.current.status === 'countdown') {
        if (!isStableDetection()) {
          cancelCountdown()
        }
      }

      pollTimeoutId = window.setTimeout(poll, 120)
    }

    poll()

    return () => {
      cancelled = true
      window.clearTimeout(pollTimeoutId)
      clearCountdown()
    }
  }, [cameraState.status, step])

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

  function assessAndStoreQuality(
    target: 'document_front' | 'document_back' | 'selfie',
    dataUrl: string,
  ) {
    const profile = target === 'selfie' ? 'selfie' : 'document'
    const cv = cvRef.current
    return assessImageQuality(dataUrl, profile, cv)
      .then((report) => {
        if (target === 'document_front') setDocumentFrontQuality(report)
        else if (target === 'document_back') setDocumentBackQuality(report)
        else setSelfieQuality(report)
        return report
      })
      .catch(() => null)
  }

  function handleUploadedAsset(
    target: 'document_front' | 'document_back' | 'selfie',
    file: File,
  ) {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : null
      if (!result) return

      if (target === 'selfie') {
        setSelfieDataUrl(result)
        setStep('selfie_preview')
        void assessAndStoreQuality('selfie', result)
        trackEvent('selfie_uploaded', { bytes: file.size, type: file.type })
        return
      }

      if (target === 'document_front') {
        setDocumentFrontDataUrl(result)
        setStep('document_front_preview')
        void assessAndStoreQuality('document_front', result)
        trackEvent('document_front_uploaded', {
          bytes: file.size,
          type: file.type,
        })
        return
      }

      setDocumentBackDataUrl(result)
      setStep('document_back_preview')
      void assessAndStoreQuality('document_back', result)
      trackEvent('document_back_uploaded', {
        bytes: file.size,
        type: file.type,
      })
    }
    reader.readAsDataURL(file)
  }

  function openUploadPicker(
    target: 'document_front' | 'document_back' | 'selfie',
  ) {
    pendingUploadTargetRef.current = target
    const input =
      target === 'selfie'
        ? selfieFileInputRef.current
        : documentFileInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }

  async function handleConfirmSubmission() {
    if (!selfieDataUrl || !documentFrontDataUrl || !documentBackDataUrl) return
    if (submitState.status === 'submitting') return

    setSubmitState({ status: 'submitting' })
    trackEvent('submission_attempted')

    try {
      const backgroundVideo = await stopBackgroundRecording()
      await onConfirm?.({
        sessionId: sessionIdRef.current,
        selfieDataUrl,
        documentFrontDataUrl,
        documentBackDataUrl,
        backgroundVideo,
      })
      setSubmitState({ status: 'submitted' })
      trackEvent('submission_success')
      setStep('success')
      void stopCamera()
    } catch (error) {
      trackEvent('submission_failed', {
        message: error instanceof Error ? error.message : 'Submission failed.',
      })
      setSubmitState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Submission failed.',
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

    const mirrored = facingMode === 'user'
    const crop =
      mode === 'document'
        ? (documentDetectRectRef.current ??
          mapCoverRectToVideoRect(video, OVERLAY_GEOMETRY.document.crop, mirrored))
        : mapCoverRectToVideoRect(video, faceCropInViewBox(), mirrored)
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
    const missingDocDetection =
      (step === 'document_front_live' || step === 'document_back_live') &&
      mode === 'document' &&
      !documentDetectRectRef.current &&
      !documentDetectQuadRef.current
    const wasAutoCapture =
      mode === 'document' &&
      (step === 'document_front_live' || step === 'document_back_live') &&
      autoCaptureStateRef.current.status === 'capturing'

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

    if (step === 'selfie_live') {
      setSelfieDataUrl(dataUrl)
      setStep('selfie_preview')
      void assessAndStoreQuality('selfie', dataUrl)
      trackEvent('selfie_captured')
      return
    }

    if (step === 'document_front_live') {
      setDocumentFrontDataUrl(dataUrl)
      setStep('document_front_preview')
      const qualityPromise = assessAndStoreQuality('document_front', dataUrl)
      trackEvent('document_front_captured')
      if (missingDocDetection) {
        trackEvent('document_front_captured_without_detection')
      }
      if (wasAutoCapture && typeof window !== 'undefined') {
        setAutoCaptureState({ status: 'idle' })
        void qualityPromise.then((report) => {
          if (report && !report.ok) return
          if (stepRef.current !== 'document_front_preview') return
          trackEvent('document_front_auto_advanced')
          setStep('document_back_live')
          void startCamera('environment')
        })
      }
      return
    }

    if (step === 'document_back_live') {
      setDocumentBackDataUrl(dataUrl)
      setStep('document_back_preview')
      const qualityPromise = assessAndStoreQuality('document_back', dataUrl)
      trackEvent('document_back_captured')
      if (missingDocDetection) {
        trackEvent('document_back_captured_without_detection')
      }
      if (wasAutoCapture && typeof window !== 'undefined') {
        setAutoCaptureState({ status: 'idle' })
        void qualityPromise.then((report) => {
          if (report && !report.ok) return
          if (stepRef.current !== 'document_back_preview') return
          trackEvent('document_back_auto_advanced')
          setStep('selfie_live')
          void startCamera('user')
        })
      }
    }
  }

	  function handlePreviewRetake() {
		    if (step === 'selfie_preview') {
		      setSelfieDataUrl(null)
		      setSelfieQuality(null)
		      trackEvent('selfie_retake')
		      setStep('selfie_live')
		      if (cameraState.status !== 'ready' || !hasLiveVideoTrack(streamRef.current)) {
		        void startCamera('user')
		      } else if (facingMode !== 'user') {
	        void flipCamera()
	      }
	      return
	    }

		    if (step === 'document_front_preview') {
		      setDocumentFrontDataUrl(null)
		      setDocumentFrontQuality(null)
		      trackEvent('document_front_retake')
		      setStep('document_front_live')
		      if (cameraState.status !== 'ready' || !hasLiveVideoTrack(streamRef.current)) {
		        void startCamera('environment')
		      } else if (facingMode !== 'environment') {
	        void flipCamera()
	      }
	      return
	    }

		    if (step === 'document_back_preview') {
		      setDocumentBackDataUrl(null)
		      setDocumentBackQuality(null)
		      trackEvent('document_back_retake')
		      setStep('document_back_live')
		      if (cameraState.status !== 'ready' || !hasLiveVideoTrack(streamRef.current)) {
		        void startCamera('environment')
		      } else if (facingMode !== 'environment') {
	        void flipCamera()
	      }
	    }
	  }

	  function handlePreviewConfirm() {
	    if (step === 'document_front_preview') {
	      trackEvent('document_front_confirmed')
	      setStep('document_back_live')
	      if (cameraState.status !== 'ready' || !hasLiveVideoTrack(streamRef.current)) {
	        void startCamera('environment')
	      } else if (facingMode !== 'environment') {
	        void flipCamera()
	      }
	      return
	    }

	    if (step === 'document_back_preview') {
	      trackEvent('document_back_confirmed')
	      setStep('selfie_live')
	      if (cameraState.status !== 'ready' || !hasLiveVideoTrack(streamRef.current)) {
	        void startCamera('user')
	      } else if (facingMode !== 'user') {
	        void flipCamera()
	      }
	      return
	    }

    if (step === 'selfie_preview') {
      trackEvent('selfie_confirmed')
      setStep('review')
    }
  }

  function handleClose() {
    trackEvent('session_close_clicked')
    if (typeof window === 'undefined') return
    try {
      window.close()
    } catch {
      // Ignore.
    }
    window.setTimeout(() => {
      window.location.assign('/')
    }, 250)
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
    const isDocLive =
      step === 'document_front_live' || step === 'document_back_live'
    if (!isDocLive || cameraState.status !== 'ready' || mode !== 'document') {
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
	    const isDocLive =
	      step === 'document_front_live' || step === 'document_back_live'
	    if (!isDocLive || cameraState.status !== 'ready' || mode !== 'document') {
	      documentDetectConfidenceRef.current = 0
	      documentDetectRectRef.current = null
	      documentDetectQuadRef.current = null
	      setDocumentDetectRect(null)
	      setDocumentDetectQuad(null)
	      setDocumentDetectConfidence(0)
	      return
	    }

    const canvas = documentDetectCanvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return

	    const ctx = canvas.getContext('2d', { willReadFrequently: true })
	    if (!ctx) return

	    const scanMaxDim = 360
	    const ensureCanvasSize = (w: number, h: number) => {
	      const nextW = Math.max(120, Math.round(w))
	      const nextH = Math.max(120, Math.round(h))
	      if (canvas.width !== nextW) canvas.width = nextW
	      if (canvas.height !== nextH) canvas.height = nextH
	    }

	    const computeScanSize = (srcW: number, srcH: number) => {
	      if (srcW <= 0 || srcH <= 0) return { w: 320, h: 240 }
	      if (srcW >= srcH) {
	        const w = scanMaxDim
	        const h = Math.max(120, Math.round((scanMaxDim * srcH) / srcW))
	        return { w, h }
	      }
	      const h = scanMaxDim
	      const w = Math.max(120, Math.round((scanMaxDim * srcW) / srcH))
	      return { w, h }
	    }

		    let lastRect: CropRect | null = null
		    let lastQuad: Quad | null = null
		    let lastUpdateAt = 0
		    let lastConfidenceUpdateAt = 0
		    let stableFrames = 0

	    const scanOnce = () => {
	      const videoW = video.videoWidth
	      const videoH = video.videoHeight
	      if (!videoW || !videoH) return

	      const crop =
	        mapCoverRectToVideoRect(
	          video,
	          OVERLAY_GEOMETRY.document.crop,
	          facingMode === 'user',
	        ) ?? ({ x: 0, y: 0, width: 1, height: 1 } satisfies CropRect)

	      const sx = clamp(Math.round(crop.x * videoW), 0, Math.max(0, videoW - 2))
	      const sy = clamp(Math.round(crop.y * videoH), 0, Math.max(0, videoH - 2))
	      const sw = clamp(
	        Math.round(crop.width * videoW),
	        2,
	        Math.max(2, videoW - sx),
	      )
	      const sh = clamp(
	        Math.round(crop.height * videoH),
	        2,
	        Math.max(2, videoH - sy),
	      )

	      const { w, h } = computeScanSize(sw, sh)
	      ensureCanvasSize(w, h)

	      const scanWidth = canvas.width
	      const scanHeight = canvas.height

	      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, scanWidth, scanHeight)
	      const image = ctx.getImageData(0, 0, scanWidth, scanHeight)
	      const data = image.data

	      const cv = cvRef.current
	      if (
        cvStatus === 'ready' &&
        cv &&
        typeof cv.matFromImageData === 'function'
      ) {
        let src: any | null = null
        let grayMat: any | null = null
        let blurMat: any | null = null
        let edgesMat: any | null = null
        let contours: any | null = null
        let hierarchy: any | null = null
        try {
          src = cv.matFromImageData(image)
          grayMat = new cv.Mat()
          blurMat = new cv.Mat()
          edgesMat = new cv.Mat()
          contours = new cv.MatVector()
          hierarchy = new cv.Mat()

          cv.cvtColor(src, grayMat, cv.COLOR_RGBA2GRAY)
          cv.GaussianBlur(grayMat, blurMat, new cv.Size(5, 5), 0)
          cv.Canny(blurMat, edgesMat, 60, 160)
          cv.findContours(
            edgesMat,
            contours,
            hierarchy,
            cv.RETR_LIST,
            cv.CHAIN_APPROX_SIMPLE,
          )

	          let bestQuad: Quad | null = null
	          let bestScore = 0
	          const distPx = (a: Point, b: Point) =>
	            Math.hypot(
	              (a.x - b.x) * scanWidth,
	              (a.y - b.y) * scanHeight,
	            )

          for (let i = 0; i < contours.size(); i++) {
            const contour = contours.get(i)
            const peri = cv.arcLength(contour, true)
            const approx = new cv.Mat()
            try {
              cv.approxPolyDP(contour, approx, 0.02 * peri, true)

              if (approx.rows === 4 && cv.isContourConvex(approx)) {
                const area = cv.contourArea(approx)
                const areaNorm = area / (scanWidth * scanHeight)
	                if (areaNorm > 0.08) {
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
	                    const topW = distPx(ordered[0], ordered[1])
	                    const botW = distPx(ordered[3], ordered[2])
	                    const leftH = distPx(ordered[0], ordered[3])
	                    const rightH = distPx(ordered[1], ordered[2])
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
            } finally {
              try {
                approx.delete()
              } catch {
                // ignore
              }
              try {
                contour.delete()
              } catch {
                // ignore
              }
            }
          }

	          const confidence = clamp(bestScore * 6.5, 0, 1)
	          documentDetectConfidenceRef.current = confidence
	          {
	            const now = window.performance.now()
	            if (now - lastConfidenceUpdateAt > 120) {
	              lastConfidenceUpdateAt = now
	              setDocumentDetectConfidence(confidence)
	            }
	          }

			          if (bestQuad && confidence >= 0.45) {
			            const toVideo = (p: Point): Point => ({
			              x: crop.x + p.x * crop.width,
			              y: crop.y + p.y * crop.height,
			            })
			            const mapped = bestQuad.map(toVideo)
			            const bestQuadVideo =
			              orderQuadPoints(mapped) ?? (mapped as unknown as Quad)
		            if (lastQuad) {
		              const delta = quadDelta(lastQuad, bestQuadVideo)
		              if (delta < 0.06) {
	                stableFrames = Math.min(6, stableFrames + 1)
	              } else {
	                stableFrames = Math.max(0, stableFrames - 1)
	              }
	            } else {
	              stableFrames = 1
	            }
	
	            const alpha = stableFrames >= 3 ? 0.35 : 0.22
	            lastQuad = lastQuad
	              ? quadLerp(lastQuad, bestQuadVideo, alpha)
	              : bestQuadVideo
	            documentDetectQuadRef.current = lastQuad
	            const rectFromQuad = quadBoundingRect(lastQuad)
	            documentDetectRectRef.current = rectFromQuad

	            const now = window.performance.now()
	            if (now - lastUpdateAt > 120) {
	              lastUpdateAt = now
	              setDocumentDetectQuad(lastQuad)
	              setDocumentDetectRect(rectFromQuad)
	              setDocumentDetectConfidence(confidence)
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
        } finally {
          try {
            hierarchy?.delete?.()
          } catch {
            // ignore
          }
          try {
            contours?.delete?.()
          } catch {
            // ignore
          }
          try {
            edgesMat?.delete?.()
          } catch {
            // ignore
          }
          try {
            blurMat?.delete?.()
          } catch {
            // ignore
          }
          try {
            grayMat?.delete?.()
          } catch {
            // ignore
          }
          try {
            src?.delete?.()
          } catch {
            // ignore
          }
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
	        const nextConfidence = Math.max(
	          0,
	          documentDetectConfidenceRef.current - 0.08,
	        )
	        documentDetectConfidenceRef.current = nextConfidence
	        {
	          const now = window.performance.now()
	          if (now - lastConfidenceUpdateAt > 120) {
	            lastConfidenceUpdateAt = now
	            setDocumentDetectConfidence(nextConfidence)
	          }
	        }
	        stableFrames = 0
	        return
	      }

      const raw: CropRect = {
        x: left.index / scanWidth,
        y: top.index / scanHeight,
        width: widthPx / scanWidth,
        height: heightPx / scanHeight,
      }

	      const aspect =
	        (raw.width * scanWidth) / Math.max(1e-6, raw.height * scanHeight)
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
	      {
	        const now = window.performance.now()
	        if (now - lastConfidenceUpdateAt > 120) {
	          lastConfidenceUpdateAt = now
	          setDocumentDetectConfidence(confidence)
	        }
	      }

	      if (confidence < 0.35) {
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
	      const desiredHeight =
	        (rect.width * scanWidth) / (DOCUMENT_TARGET_ASPECT * scanHeight)
	      if (Math.abs(desiredHeight - rect.height) / rect.height > 0.08) {
	        rect = normalizeRect({
	          x: rect.x,
	          y: cy - desiredHeight / 2,
	          width: rect.width,
	          height: desiredHeight,
	        })
	      }

	      const rectInVideo = normalizeRect({
	        x: crop.x + rect.x * crop.width,
	        y: crop.y + rect.y * crop.height,
	        width: rect.width * crop.width,
	        height: rect.height * crop.height,
	      })

	      if (lastRect) {
	        const dx =
	          Math.abs(rectInVideo.x - lastRect.x) +
	          Math.abs(rectInVideo.y - lastRect.y)
	        const ds =
	          Math.abs(rectInVideo.width - lastRect.width) +
	          Math.abs(rectInVideo.height - lastRect.height)
	        if (dx + ds < 0.03) {
	          stableFrames = Math.min(6, stableFrames + 1)
	        } else {
	          stableFrames = Math.max(0, stableFrames - 1)
	        }
	      } else {
	        stableFrames = 1
	      }

	      const alpha = stableFrames >= 3 ? 0.35 : 0.22
	      lastRect = lastRect ? rectLerp(lastRect, rectInVideo, alpha) : rectInVideo
	      documentDetectRectRef.current = lastRect

	      const now = window.performance.now()
	      if (now - lastUpdateAt > 120) {
	        lastUpdateAt = now
	        setDocumentDetectRect(lastRect)
	        setDocumentDetectConfidence(confidence)
	      }
    }

    const targetIntervalMs = 140
    let timeoutId = 0
    let cancelled = false

    const loop = () => {
      if (cancelled) return
      const startedAt = window.performance.now()
      scanOnce()
      const finishedAt = window.performance.now()
      const elapsed = Math.max(0, finishedAt - startedAt)
      const delay = Math.max(60, targetIntervalMs - elapsed)
      timeoutId = window.setTimeout(loop, delay)
    }

    loop()
    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
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
    if (step === 'selfie_live' && facingMode !== 'user') {
      void flipCamera()
      return
    }
    if (
      (step === 'document_front_live' || step === 'document_back_live') &&
      facingMode !== 'environment'
    ) {
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

	  const activeQuality =
	    step === 'document_front_preview'
	      ? documentFrontQuality
	      : step === 'document_back_preview'
	        ? documentBackQuality
	        : step === 'selfie_preview'
	          ? selfieQuality
	          : null

		  const displayDocumentRect = useMemo(() => {
		    if (typeof window === 'undefined') return documentDetectRect
		    const video = videoRef.current
		    if (!video || !documentDetectRect) return documentDetectRect
		    return (
		      mapVideoRectToCoverRect(video, documentDetectRect, facingMode === 'user') ??
		      documentDetectRect
		    )
		  }, [documentDetectRect, facingMode])

		  const displayDocumentQuad = useMemo(() => {
		    if (typeof window === 'undefined') return documentDetectQuad
		    const video = videoRef.current
		    if (!video || !documentDetectQuad) return documentDetectQuad
		    return (
		      mapVideoQuadToCoverQuad(video, documentDetectQuad, facingMode === 'user') ??
		      documentDetectQuad
		    )
		  }, [documentDetectQuad, facingMode])

	  const primaryActionLabel =
	    step === 'selfie_live'
	      ? 'Capture'
	      : step === 'document_front_live' || step === 'document_back_live'
	        ? 'Capture now'
        : null

  const activeStep =
    step === 'document_front_live' || step === 'document_front_preview'
      ? 'front'
      : step === 'document_back_live' || step === 'document_back_preview'
        ? 'back'
        : step === 'selfie_live' || step === 'selfie_preview'
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
                setStep(
                  documentFrontComplete
                    ? 'document_front_preview'
                    : 'document_front_live',
                )
              }
              aria-current={activeStep === 'front' ? 'step' : undefined}
              className="group inline-flex items-center gap-2 text-left"
            >
              <span
                className={[
                  'grid h-8 w-8 place-items-center rounded-full border text-sm font-semibold transition',
                  activeStep === 'front'
                    ? 'border-[var(--lagoon)] bg-[var(--lagoon)] text-white'
                    : documentFrontComplete
                      ? 'border-[var(--lagoon)] bg-[var(--accent-soft)] text-[var(--lagoon-deep)]'
                      : 'border-[var(--chip-line)] bg-[var(--chip-bg)] text-[var(--sea-ink-soft)] group-hover:text-[var(--sea-ink)]',
                ].join(' ')}
              >
                1
              </span>
              <span
                className={[
                  'text-sm font-semibold transition',
                  activeStep === 'front' || documentFrontComplete
                    ? 'text-[var(--sea-ink)]'
                    : 'text-[var(--sea-ink-soft)] group-hover:text-[var(--sea-ink)]',
                ].join(' ')}
              >
                ID front
              </span>
            </button>
          </li>

          <li
            aria-hidden="true"
            className={[
              'h-[2px] w-10 rounded-full sm:w-14',
              documentFrontComplete
                ? 'bg-[linear-gradient(90deg,var(--lagoon),#75b5ff)]'
                : 'bg-[var(--line)]',
            ].join(' ')}
          />

          <li className="flex items-center gap-3">
            <button
              type="button"
              onClick={() =>
                documentFrontComplete
                  ? setStep(
                      documentBackComplete
                        ? 'document_back_preview'
                        : 'document_back_live',
                    )
                  : undefined
              }
              disabled={!documentFrontComplete}
              aria-current={activeStep === 'back' ? 'step' : undefined}
              className="group inline-flex items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span
                className={[
                  'grid h-8 w-8 place-items-center rounded-full border text-sm font-semibold transition',
                  activeStep === 'back'
                    ? 'border-[var(--lagoon)] bg-[var(--lagoon)] text-white'
                    : documentBackComplete
                      ? 'border-[var(--lagoon)] bg-[var(--accent-soft)] text-[var(--lagoon-deep)]'
                      : 'border-[var(--chip-line)] bg-[var(--chip-bg)] text-[var(--sea-ink-soft)] group-hover:text-[var(--sea-ink)]',
                ].join(' ')}
              >
                2
              </span>
              <span
                className={[
                  'text-sm font-semibold transition',
                  activeStep === 'back' || documentBackComplete
                    ? 'text-[var(--sea-ink)]'
                    : 'text-[var(--sea-ink-soft)] group-hover:text-[var(--sea-ink)]',
                ].join(' ')}
              >
                ID back
              </span>
            </button>
          </li>

          <li
            aria-hidden="true"
            className={[
              'h-[2px] w-10 rounded-full sm:w-14',
              documentBackComplete
                ? 'bg-[linear-gradient(90deg,var(--lagoon),#75b5ff)]'
                : 'bg-[var(--line)]',
            ].join(' ')}
          />

          <li className="flex items-center gap-3">
            <button
              type="button"
              onClick={() =>
                documentFrontComplete && documentBackComplete
                  ? setStep(selfieComplete ? 'selfie_preview' : 'selfie_live')
                  : undefined
              }
              disabled={!documentFrontComplete || !documentBackComplete}
              aria-current={activeStep === 'selfie' ? 'step' : undefined}
              className="group inline-flex items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span
                className={[
                  'grid h-8 w-8 place-items-center rounded-full border text-sm font-semibold transition',
                  activeStep === 'selfie'
                    ? 'border-[var(--lagoon)] bg-[var(--lagoon)] text-white'
                    : selfieComplete
                      ? 'border-[var(--lagoon)] bg-[var(--accent-soft)] text-[var(--lagoon-deep)]'
                      : 'border-[var(--chip-line)] bg-[var(--chip-bg)] text-[var(--sea-ink-soft)] group-hover:text-[var(--sea-ink)]',
                ].join(' ')}
              >
                3
              </span>
              <span
                className={[
                  'text-sm font-semibold transition',
                  activeStep === 'selfie' || selfieComplete
                    ? 'text-[var(--sea-ink)]'
                    : 'text-[var(--sea-ink-soft)] group-hover:text-[var(--sea-ink)]',
                ].join(' ')}
              >
                Selfie + ID
              </span>
            </button>
          </li>

          <li
            aria-hidden="true"
            className={[
              'h-[2px] w-10 rounded-full sm:w-14',
              selfieComplete
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
                4
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
          const target = pendingUploadTargetRef.current
          handleUploadedAsset(
            target === 'selfie' ? 'document_front' : target,
            file,
          )
        }}
      />
      <input
        ref={selfieFileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          if (!file) return
          handleUploadedAsset('selfie', file)
        }}
      />
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="island-kicker mb-2">{headerKicker}</p>
          <h1 className="display-title m-0 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
            {headerTitle}
          </h1>
          <p className="mt-2 mb-0 max-w-2xl text-sm text-[var(--sea-ink-soft)] sm:text-base">
            {headerSubtitle}
          </p>
          {step === 'selfie_live' ||
          step === 'document_front_live' ||
          step === 'document_back_live' ? (
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
            </div>
          ) : null}

          {submitState.status === 'error' && step === 'review' ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--sea-ink-soft)]">
              <span className="inline-flex items-center rounded-full border border-[rgba(200,60,60,0.25)] bg-[rgba(255,255,255,0.55)] px-3 py-1 text-[rgba(140,30,30,0.9)]">
                Upload failed: {submitState.message}
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex w-full flex-col flex-wrap items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
          {step === 'intro' ? null : stepper}

          {step === 'success' ? null : step === 'review' ? (
	        <>
              <button
                type="button"
                onClick={() => setStep('document_front_preview')}
                disabled={!documentFrontComplete}
                className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)] disabled:opacity-50"
              >
                Edit front
              </button>
              <button
                type="button"
                onClick={() => setStep('document_back_preview')}
                disabled={!documentBackComplete}
                className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)] disabled:opacity-50"
              >
                Edit back
              </button>
              <button
                type="button"
                onClick={() => setStep('selfie_preview')}
                disabled={!selfieComplete}
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
          ) : step === 'selfie_live' ||
            step === 'document_front_live' ||
            step === 'document_back_live' ? (
            <div className="hidden flex-wrap items-center gap-2 sm:flex">
              <button
                type="button"
                onClick={() => {
                  void stopCamera()
                  openUploadPicker(
                    step === 'selfie_live'
                      ? 'selfie'
                      : step === 'document_back_live'
                        ? 'document_back'
                        : 'document_front',
                  )
                }}
                className="rounded-full border border-[var(--chip-line)] bg-white/60 px-4 py-2 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)]"
              >
                Upload photo
              </button>

              {cameraState.status === 'ready' ? (
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
	                  onClick={() =>
	                    startCamera(step === 'selfie_live' ? 'user' : 'environment')
	                  }
	                  disabled={cameraState.status === 'starting'}
	                  className="rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_var(--shadow-strong)] transition hover:-translate-y-0.5 disabled:opacity-60"
	                >
	                  {cameraState.status === 'starting'
	                    ? 'Starting…'
	                    : 'Start camera'}
	                </button>
              )}
            </div>
          ) : null}
        </div>
      </header>

      {step === 'intro' ? (
        <div className="mt-6 grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="rounded-2xl border border-[var(--line)] bg-white/50 p-6 text-[var(--sea-ink-soft)] shadow-[0_18px_34px_var(--shadow-soft)]">
            <p className="island-kicker mb-2">What’s about to happen</p>
            <ol className="mt-4 mb-0 list-decimal space-y-2 pl-5 text-sm leading-7">
              <li>Capture or upload a clear photo of the front of your ID.</li>
              <li>Capture or upload a clear photo of the back of your ID.</li>
              <li>Capture or upload a selfie while holding your ID.</li>
              <li>Review all images and submit.</li>
            </ol>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <figure className="m-0 overflow-hidden rounded-2xl border border-[var(--line)] bg-white/60 shadow-[0_10px_20px_var(--shadow-soft)]">
                <img
                  src="/examples/id-front-example.svg"
                  alt="Example front-of-ID photo"
                  className="h-auto w-full"
                  loading="lazy"
                />
                <figcaption className="border-t border-[var(--line)] px-4 py-3 text-xs font-semibold text-[var(--sea-ink-soft)]">
                  ID front example
                </figcaption>
              </figure>
              <figure className="m-0 overflow-hidden rounded-2xl border border-[var(--line)] bg-white/60 shadow-[0_10px_20px_var(--shadow-soft)]">
                <img
                  src="/examples/id-back-example.svg"
                  alt="Example back-of-ID photo"
                  className="h-auto w-full"
                  loading="lazy"
                />
                <figcaption className="border-t border-[var(--line)] px-4 py-3 text-xs font-semibold text-[var(--sea-ink-soft)]">
                  ID back example
                </figcaption>
              </figure>
            </div>

            <div className="mt-5 rounded-2xl border border-[var(--line)] bg-[var(--chip-bg)] p-4 text-sm leading-7">
              <p className="m-0 font-semibold text-[var(--sea-ink)]">
                Tips for best results
              </p>
              <ul className="mt-2 mb-0 list-disc space-y-1 pl-5">
                <li>Use bright, even lighting and avoid glare.</li>
                <li>Keep the ID fully inside the frame.</li>
                <li>Hold still — we can auto-capture when stable.</li>
              </ul>
            </div>
          </div>

	          <div className="rounded-2xl border border-[var(--line)] bg-white/50 p-6 text-[var(--sea-ink-soft)] shadow-[0_18px_34px_var(--shadow-soft)]">
	            <p className="island-kicker mb-2">Consent</p>
		            <div
		              className="mt-4 flex items-start gap-3 text-sm leading-7"
		              onClick={(event) => {
		                const target = event.target as HTMLElement | null
		                if (!target) return
		                if (target.closest('a')) return
		                if (target.closest('button')) return
		                if (target.closest('input')) return
		                setPoliciesAccepted((prev) => !prev)
		              }}
		            >
		              <input
		                id="veries-consent"
		                type="checkbox"
		                checked={policiesAccepted}
	                onChange={(event) =>
	                  setPoliciesAccepted(event.currentTarget.checked)
	                }
	                className="mt-1 h-4 w-4 cursor-pointer accent-[var(--lagoon)]"
	              />
		              <span>
		                <label htmlFor="veries-consent" className="cursor-pointer">
		                  I agree to the{' '}
		                </label>
		                <Link
		                  to="/terms"
		                  className="font-semibold text-[var(--lagoon-deep)] no-underline hover:underline"
		                >
	                  Terms of Use
	                </Link>{' '}
	                and{' '}
	                <Link
	                  to="/privacy"
	                  className="font-semibold text-[var(--lagoon-deep)] no-underline hover:underline"
	                >
	                  Privacy Policy
	                </Link>
	                .
	              </span>
	            </div>

	            <button
	              type="button"
	              onClick={() => {
	                if (!policiesAccepted) setPoliciesAccepted(true)
	                trackEvent('intro_accepted')
	                setStep('document_front_live')
	                if (typeof window !== 'undefined') {
	                  window.scrollTo({ top: 0, behavior: 'smooth' })
	                }
	              }}
	              className="mt-5 w-full rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_var(--shadow-strong)] disabled:opacity-60"
	            >
		              Next
		            </button>
		            {!policiesAccepted ? (
		              <p className="mt-2 mb-0 text-xs leading-6 text-[rgba(140,30,30,0.9)]">
		                You can tick the consent box above to record agreement, but
		                you can also continue.
		              </p>
		            ) : null}

	            <p className="mt-4 mb-0 text-xs leading-6 text-[var(--sea-ink-soft)]">
	              You can switch to uploading images if camera access isn’t
	              available.
	            </p>
	          </div>
        </div>
      ) : step === 'review' ? (
        <>
          <ReviewScreen
            selfieDataUrl={selfieDataUrl}
            documentFrontDataUrl={documentFrontDataUrl}
            documentBackDataUrl={documentBackDataUrl}
            onEditSelfie={() => setStep('selfie_preview')}
            onEditDocumentFront={() => setStep('document_front_preview')}
            onEditDocumentBack={() => setStep('document_back_preview')}
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
                      : 'Confirm all images to finish.'}
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
          <p className="island-kicker mb-2">Thank you</p>
          <h2 className="m-0 text-lg font-semibold text-[var(--sea-ink)]">
            Your documents were uploaded successfully.
          </h2>
          <p className="mt-2 mb-0 text-sm">
            You can close this page now, or start a new verification session.
          </p>

          <ul className="mt-4 mb-0 list-disc space-y-1 pl-5 text-sm">
            <li>ID front photo: uploaded</li>
            <li>ID back photo: uploaded</li>
            <li>Selfie photo: uploaded</li>
            <li>
              Background video:{' '}
              {recordingState.status === 'unsupported'
                ? 'not supported'
                : recordingState.status === 'error'
                  ? 'error'
                  : 'captured when available'}
            </li>
          </ul>

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_var(--shadow-strong)]"
            >
              Close
            </button>
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
	                setPoliciesAccepted(false)
	                setSelfieDataUrl(null)
	                setSelfieQuality(null)
	                setDocumentFrontDataUrl(null)
	                setDocumentFrontQuality(null)
	                setDocumentBackDataUrl(null)
	                setDocumentBackQuality(null)
	                setStep('intro')
	                trackEvent('session_restart')
	              }}
              className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink)]"
            >
              Start new
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
	              <div className="relative overflow-hidden rounded-2xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--sand)_70%,black_30%)] shadow-[0_18px_44px_var(--shadow-deep)]">
	              <div className="relative" style={{ aspectRatio: '4 / 5' }}>
	                <video
	                  ref={videoRef}
	                  className={[
	                    'absolute inset-0 h-full w-full object-cover transition-opacity',
	                    facingMode === 'user' ? '[transform:scaleX(-1)]' : '',
	                    step.endsWith('_preview') ? 'opacity-0' : 'opacity-100',
	                  ].join(' ')}
	                  autoPlay
	                  playsInline
	                  muted
	                />
	                {step === 'selfie_preview' && selfieDataUrl ? (
	                  <img
	                    src={selfieDataUrl}
	                    alt="Captured selfie preview"
	                    className="absolute inset-0 h-full w-full object-cover"
	                  />
	                ) : null}
	                {step === 'document_front_preview' && documentFrontDataUrl ? (
	                  <img
	                    src={documentFrontDataUrl}
	                    alt="Captured ID front preview"
	                    className="absolute inset-0 h-full w-full object-cover"
	                  />
	                ) : null}
	                {step === 'document_back_preview' && documentBackDataUrl ? (
	                  <img
	                    src={documentBackDataUrl}
	                    alt="Captured ID back preview"
	                    className="absolute inset-0 h-full w-full object-cover"
	                  />
	                ) : null}

	                {step === 'selfie_live' ||
	                step === 'document_front_live' ||
	                step === 'document_back_live' ? (
	                  <Overlay
	                    mode={mode}
	                    documentRect={displayDocumentRect}
	                    documentQuad={displayDocumentQuad}
	                  />
	                ) : null}

                <div className="absolute left-4 top-4 rounded-full border border-[rgba(255,255,255,0.25)] bg-[rgba(15,27,31,0.55)] px-3 py-1.5 text-xs font-semibold tracking-wide text-white">
                  {mode === 'face'
                    ? 'SELFIE'
                    : step === 'document_back_live' ||
                        step === 'document_back_preview'
                      ? 'ID BACK'
                      : 'ID FRONT'}
	                  {cameraState.status === 'ready' ? (
	                    <span className="ml-2 text-white/70">
	                      {facingMode === 'user' ? 'Front' : 'Back'}
	                    </span>
	                  ) : null}
	                  {cameraState.status === 'ready' &&
	                  mode === 'document' &&
	                  (step === 'document_front_live' ||
	                    step === 'document_back_live') ? (
	                    <span className="ml-2 text-white/70">
	                      {Math.round(documentDetectConfidence * 100)}%
	                    </span>
	                  ) : null}
	                </div>

                <div className="absolute left-4 right-4 bottom-4 rounded-2xl border border-[rgba(255,255,255,0.18)] bg-[rgba(15,27,31,0.55)] px-3 py-2 text-left text-[11px] text-white/80 backdrop-blur-sm sm:px-4 sm:py-3 sm:text-xs">
                  <p className="m-0 font-semibold text-white">
                    {mode === 'face'
                      ? 'Align your face in the oval and hold your ID visibly.'
                      : step === 'document_back_live' ||
                          step === 'document_back_preview'
                        ? 'Capture the back of your ID. Keep it inside the frame and avoid glare.'
                        : 'Capture the front of your ID. Keep it inside the frame and avoid glare.'}
                  </p>
                  <p className="mt-1 mb-0">
                    {mode === 'face'
                      ? 'Bright, even lighting helps. Keep both face + ID sharp.'
                      : 'Hold steady — we’ll auto-capture when the ID is stable.'}
                  </p>
                </div>

                {previewOverlayCopy &&
                (step === 'selfie_live' ||
                  step === 'document_front_live' ||
                  step === 'document_back_live') ? (
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

                {cameraState.status === 'ready' &&
                (step === 'document_front_live' ||
                  step === 'document_back_live') &&
                autoCaptureState.status !== 'idle' ? (
                  <div className="absolute inset-0 grid place-items-center bg-[rgba(8,14,16,0.35)] px-4 text-center sm:px-6">
                    <div className="max-w-sm">
                      <p className="m-0 text-sm font-semibold text-white">
                        Hold still
                      </p>
                      <p className="mt-2 mb-0 text-sm text-white/75">
                        {autoCaptureState.status === 'countdown'
                          ? `Capturing in ${autoCaptureState.secondsLeft}…`
                          : 'Capturing…'}
                      </p>
                      {autoCaptureState.status === 'countdown' ? (
                        <p className="mt-4 mb-0 text-5xl font-semibold tracking-tight text-white">
                          {autoCaptureState.secondsLeft}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <aside className="island-shell rounded-2xl p-5">
              <p className="island-kicker mb-2">On-screen guidance</p>
              <h2 className="m-0 text-lg font-semibold text-[var(--sea-ink)]">
                {mode === 'face'
                  ? 'Selfie + ID check'
                  : step === 'document_back_live' ||
                      step === 'document_back_preview'
                    ? 'Back of ID capture'
                    : 'Front of ID capture'}
              </h2>
	              <ul className="mt-4 mb-0 list-disc space-y-2 pl-5 text-sm leading-6 text-[var(--sea-ink-soft)]">
	                {tips.map((tip) => (
	                  <li key={tip}>{tip}</li>
	                ))}
	              </ul>
	
	              {activeQuality ? (
	                <div
	                  className={[
	                    'mt-5 rounded-2xl border p-4 text-sm leading-6',
	                    activeQuality.ok
	                      ? 'border-[rgba(60,160,95,0.25)] bg-[rgba(255,255,255,0.55)] text-[rgba(30,90,55,0.95)]'
	                      : 'border-[rgba(200,140,60,0.25)] bg-[rgba(255,255,255,0.55)] text-[rgba(120,70,20,0.95)]',
	                  ].join(' ')}
	                >
	                  <p className="m-0 font-semibold">
	                    {activeQuality.ok ? 'Quality looks good' : 'Quality warning'}
	                  </p>
	                  {activeQuality.ok ? (
	                    <p className="mt-1 mb-0">
	                      If anything is hard to read, retake before continuing.
	                    </p>
	                  ) : (
	                    <p className="mt-1 mb-0">
	                      {activeQuality.issues.includes('too_blurry')
	                        ? 'Image looks blurry — hold steady and try again.'
	                        : activeQuality.issues.includes('glare_high')
	                          ? 'There’s a lot of glare — tilt the card slightly.'
	                          : activeQuality.issues.includes('too_dark')
	                            ? 'Image is too dark — move into better light.'
	                            : activeQuality.issues.includes('too_bright')
	                              ? 'Image is too bright — reduce direct light.'
	                              : activeQuality.issues.includes('too_small')
	                                ? 'Move closer so the ID fills more of the frame.'
	                                : 'Retake for a clearer image.'}
	                    </p>
	                  )}
	                </div>
	              ) : null}

	              {step === 'selfie_preview' ||
	              step === 'document_front_preview' ||
	              step === 'document_back_preview' ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handlePreviewRetake}
                    className="rounded-full border border-[var(--chip-line)] bg-white/60 px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)]"
                  >
                    Retake
                  </button>
                  <button
                    type="button"
                    onClick={handlePreviewConfirm}
                    className="rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_var(--shadow-strong)] transition hover:-translate-y-0.5"
                  >
                    {step === 'document_front_preview'
                      ? 'Use front photo'
                      : step === 'document_back_preview'
                        ? 'Use back photo'
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

              {step === 'selfie_live' || step === 'selfie_preview' ? (
                <figure className="mt-5 m-0 overflow-hidden rounded-2xl border border-[var(--line)] bg-white/60 shadow-[0_10px_20px_var(--shadow-soft)]">
                  <img
                    src="/examples/selfie-example.svg"
                    alt="Example selfie holding an ID"
                    className="h-auto w-full"
                    loading="lazy"
                  />
                  <figcaption className="border-t border-[var(--line)] px-4 py-3 text-xs font-semibold text-[var(--sea-ink-soft)]">
                    Selfie + ID example
                  </figcaption>
                </figure>
              ) : null}
            </aside>
          </div>

	          {step === 'selfie_live' ||
	          step === 'document_front_live' ||
	          step === 'document_back_live' ? (
	            <>
	              <div className="h-28 sm:hidden" aria-hidden="true" />
	              <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--line)] bg-white/70 backdrop-blur-sm sm:hidden">
	                <div className="page-wrap py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
	                  {cameraState.status === 'ready' ? (
	                    <div className="grid gap-2">
	                      <div className="grid grid-cols-3 gap-2">
	                        <button
	                          type="button"
	                          onClick={() => {
	                            void stopCamera()
	                            openUploadPicker(
	                              step === 'selfie_live'
	                                ? 'selfie'
	                                : step === 'document_back_live'
	                                  ? 'document_back'
	                                  : 'document_front',
	                            )
	                          }}
	                          className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink)]"
	                        >
	                          Upload
	                        </button>
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
	                      </div>
	                      <button
	                        type="button"
	                        onClick={handleCapture}
	                        disabled={
	                          (step === 'document_front_live' ||
	                            step === 'document_back_live') &&
	                          autoCaptureState.status !== 'idle'
	                        }
	                        className="w-full rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_var(--shadow-strong)] disabled:opacity-60"
	                      >
	                        {step === 'document_front_live' ||
	                        step === 'document_back_live'
	                          ? autoCaptureState.status === 'countdown'
	                            ? `Capturing in ${autoCaptureState.secondsLeft}…`
	                            : autoCaptureState.status === 'capturing'
	                              ? 'Capturing…'
	                              : 'Capture now'
	                          : 'Capture'}
	                      </button>
	                    </div>
	                  ) : (
	                    <div className="flex items-center gap-2">
	                      <button
	                        type="button"
	                        onClick={() => {
	                          void stopCamera()
	                          openUploadPicker(
	                            step === 'selfie_live'
	                              ? 'selfie'
	                              : step === 'document_back_live'
	                                ? 'document_back'
	                                : 'document_front',
	                          )
	                        }}
	                        className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink)]"
	                      >
	                        Upload
	                      </button>
		                      <button
		                        type="button"
		                        onClick={() =>
		                          startCamera(
		                            step === 'selfie_live' ? 'user' : 'environment',
		                          )
		                        }
		                        disabled={cameraState.status === 'starting'}
		                        className="ml-auto rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_var(--shadow-strong)] disabled:opacity-60"
		                      >
	                        {cameraState.status === 'starting'
	                          ? 'Starting…'
	                          : 'Start camera'}
	                      </button>
	                    </div>
	                  )}
	                </div>
	              </div>
	            </>
	          ) : null}

	          {step === 'selfie_preview' ||
	          step === 'document_front_preview' ||
	          step === 'document_back_preview' ? (
	            <>
	              <div className="h-24 sm:hidden" aria-hidden="true" />
	              <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--line)] bg-white/70 backdrop-blur-sm sm:hidden">
	                <div className="page-wrap flex items-center justify-between gap-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
	                  <button
	                    type="button"
	                    onClick={handlePreviewRetake}
	                    className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink)]"
	                  >
	                    Retake
	                  </button>
	                  <button
	                    type="button"
	                    onClick={handlePreviewConfirm}
	                    className="ml-auto rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-5 py-2 text-sm font-semibold text-[var(--lagoon-deep)] shadow-[0_12px_22px_var(--shadow-strong)]"
	                  >
	                    {step === 'document_front_preview'
	                      ? 'Use front'
	                      : step === 'document_back_preview'
	                        ? 'Use back'
	                        : 'Continue'}
	                  </button>
	                </div>
	              </div>
	            </>
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
  const targetCutoutRect =
    mode === 'document'
      ? (documentRect ?? OVERLAY_GEOMETRY.document.crop)
      : null

  const targetQuad = useMemo(() => {
    if (mode !== 'document') return null
    if (documentQuad) return documentQuad
    if (!documentRect) return null
    return [
      { x: documentRect.x, y: documentRect.y },
      { x: documentRect.x + documentRect.width, y: documentRect.y },
      {
        x: documentRect.x + documentRect.width,
        y: documentRect.y + documentRect.height,
      },
      { x: documentRect.x, y: documentRect.y + documentRect.height },
    ] as Quad
  }, [documentQuad, documentRect, mode])

  const targetCutoutRectRef = useRef<CropRect | null>(targetCutoutRect)
  const targetQuadRef = useRef<Quad | null>(targetQuad)
  useEffect(() => {
    targetCutoutRectRef.current = targetCutoutRect
    targetQuadRef.current = targetQuad
  }, [targetCutoutRect, targetQuad])

  const [animatedCutoutRect, setAnimatedCutoutRect] = useState<CropRect | null>(
    targetCutoutRect,
  )
  const [animatedQuad, setAnimatedQuad] = useState<Quad | null>(targetQuad)

  const animatedCutoutRectRef = useRef<CropRect | null>(targetCutoutRect)
  const animatedQuadRef = useRef<Quad | null>(targetQuad)

  useEffect(() => {
    if (mode !== 'document') {
      setAnimatedCutoutRect(null)
      setAnimatedQuad(null)
      animatedCutoutRectRef.current = null
      animatedQuadRef.current = null
      return
    }

    const ensureRect = () => {
      if (!animatedCutoutRectRef.current && targetCutoutRectRef.current) {
        animatedCutoutRectRef.current = targetCutoutRectRef.current
        setAnimatedCutoutRect(targetCutoutRectRef.current)
      }
    }

    ensureRect()

    const smoothingMs = 80
    const epsilonRect = 0.001
    const epsilonQuad = 0.002
    let rafId = 0
    let lastTs = 0

    const tick = (ts: number) => {
      const dt = Math.max(0, Math.min(80, ts - lastTs || 16.7))
      lastTs = ts
      const alpha = 1 - Math.exp(-dt / smoothingMs)

      const targetRectNow = targetCutoutRectRef.current
      const currentRect = animatedCutoutRectRef.current
      if (targetRectNow && currentRect && currentRect !== targetRectNow) {
        const delta = rectDelta(currentRect, targetRectNow)
        if (delta > epsilonRect) {
          const nextRect = rectLerp(currentRect, targetRectNow, alpha)
          animatedCutoutRectRef.current = nextRect
          setAnimatedCutoutRect(nextRect)
        } else {
          animatedCutoutRectRef.current = targetRectNow
          setAnimatedCutoutRect(targetRectNow)
        }
      }

      const targetQuadNow = targetQuadRef.current
      const currentQuad = animatedQuadRef.current
      if (targetQuadNow) {
        if (currentQuad && currentQuad !== targetQuadNow) {
          const delta = quadDelta(currentQuad, targetQuadNow)
          if (delta > epsilonQuad) {
            const nextQuad = quadLerp(currentQuad, targetQuadNow, alpha)
            animatedQuadRef.current = nextQuad
            setAnimatedQuad(nextQuad)
          } else {
            animatedQuadRef.current = targetQuadNow
            setAnimatedQuad(targetQuadNow)
          }
        } else {
          animatedQuadRef.current = targetQuadNow
          setAnimatedQuad(targetQuadNow)
        }
      } else if (currentQuad) {
        animatedQuadRef.current = null
        setAnimatedQuad(null)
      }

      rafId = window.requestAnimationFrame(tick)
    }

    rafId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(rafId)
  }, [mode])

  const quad: Quad | null =
    animatedQuad ??
    (animatedCutoutRect
      ? ([
          { x: animatedCutoutRect.x, y: animatedCutoutRect.y },
          {
            x: animatedCutoutRect.x + animatedCutoutRect.width,
            y: animatedCutoutRect.y,
          },
          {
            x: animatedCutoutRect.x + animatedCutoutRect.width,
            y: animatedCutoutRect.y + animatedCutoutRect.height,
          },
          {
            x: animatedCutoutRect.x,
            y: animatedCutoutRect.y + animatedCutoutRect.height,
          },
        ] as const)
      : null)

  const quadView = quad
    ? (quad.map((p) => ({ x: p.x * 100, y: p.y * 100 })) as unknown as Quad)
    : null

  const quadPath = quadView
    ? `M${quadView[0].x},${quadView[0].y} L${quadView[1].x},${quadView[1].y} L${quadView[2].x},${quadView[2].y} L${quadView[3].x},${quadView[3].y} Z`
    : null

  const documentCutout = animatedCutoutRect
    ? {
        x: animatedCutoutRect.x * 100,
        y: animatedCutoutRect.y * 100,
        width: animatedCutoutRect.width * 100,
        height: animatedCutoutRect.height * 100,
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
  documentFrontDataUrl,
  documentBackDataUrl,
  selfieDataUrl,
  onEditDocumentFront,
  onEditDocumentBack,
  onEditSelfie,
}: {
  documentFrontDataUrl: string | null
  documentBackDataUrl: string | null
  selfieDataUrl: string | null
  onEditDocumentFront: () => void
  onEditDocumentBack: () => void
  onEditSelfie: () => void
}) {
  return (
    <div className="mt-6 mb-24 space-y-5 lg:mb-0">
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="island-shell rounded-2xl p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="island-kicker mb-1">Document</p>
              <p className="m-0 text-sm font-semibold text-[var(--sea-ink)]">
                ID front
              </p>
            </div>
            <button
              type="button"
              onClick={onEditDocumentFront}
              className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)]"
            >
              Edit
            </button>
          </div>
          <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--sand)_70%,black_30%)]">
            <div className="relative" style={{ aspectRatio: '4 / 3' }}>
              {documentFrontDataUrl ? (
                <img
                  src={documentFrontDataUrl}
                  alt="ID front capture"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-white/75">
                  Missing ID front image
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
                ID back
              </p>
            </div>
            <button
              type="button"
              onClick={onEditDocumentBack}
              className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)]"
            >
              Edit
            </button>
          </div>
          <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--sand)_70%,black_30%)]">
            <div className="relative" style={{ aspectRatio: '4 / 3' }}>
              {documentBackDataUrl ? (
                <img
                  src={documentBackDataUrl}
                  alt="ID back capture"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-white/75">
                  Missing ID back image
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="island-shell rounded-2xl p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="island-kicker mb-1">Selfie</p>
              <p className="m-0 text-sm font-semibold text-[var(--sea-ink)]">
                Selfie + ID
              </p>
            </div>
            <button
              type="button"
              onClick={onEditSelfie}
              className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] shadow-[0_8px_18px_var(--shadow-soft)]"
            >
              Edit
            </button>
          </div>
          <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--sand)_70%,black_30%)]">
            <div className="relative" style={{ aspectRatio: '4 / 5' }}>
              {selfieDataUrl ? (
                <img
                  src={selfieDataUrl}
                  alt="Selfie capture"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-white/75">
                  Missing selfie image
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--line)] bg-white/50 p-4 text-sm text-[var(--sea-ink-soft)]">
        <p className="m-0 font-semibold text-[var(--sea-ink)]">
          Quick checklist
        </p>
        <ul className="mt-2 mb-0 list-disc space-y-1 pl-5">
          <li>Text is readable (not blurry).</li>
          <li>No glare over key details.</li>
          <li>All edges are visible.</li>
          <li>Your face is clear and the ID is readable in the selfie.</li>
        </ul>
      </div>
    </div>
  )
}
