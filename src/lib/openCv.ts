type CvModule = unknown

let cvPromise: Promise<CvModule> | null = null

export async function loadOpenCv(): Promise<CvModule> {
  if (typeof window === 'undefined') {
    throw new Error('OpenCV can only be loaded in the browser.')
  }

  if (cvPromise) return cvPromise

  cvPromise = (async () => {
    const mod = (await import('@techstark/opencv-js')) as any
    const cvModule = mod?.default ?? mod?.cv ?? mod

    if (!cvModule) {
      throw new Error('Failed to import OpenCV module.')
    }

    // Some builds export a Promise/thenable.
    if (typeof cvModule?.then === 'function') {
      return await cvModule
    }

    const isReady = (cv: any) =>
      typeof cv?.Mat === 'function' &&
      typeof cv?.matFromImageData === 'function' &&
      typeof cv?.getPerspectiveTransform === 'function' &&
      typeof cv?.warpPerspective === 'function' &&
      typeof cv?.imshow === 'function'

    // Make it available as `globalThis.cv` for any code that expects it.
    try {
      ;(globalThis as any).cv = cvModule
    } catch {
      // ignore
    }

    if (isReady(cvModule)) return cvModule

    // Prefer a built-in readiness signal if present.
    if (cvModule?.ready && typeof cvModule.ready.then === 'function') {
      await cvModule.ready
      if (isReady(cvModule)) return cvModule
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error('Timed out waiting for OpenCV to initialize.'))
      }, 20_000)

      const tick = () => {
        if (isReady(cvModule)) {
          window.clearTimeout(timeout)
          resolve()
          return
        }
        window.setTimeout(tick, 50)
      }

      // Emscripten-style callback (may fire before we attach, so we still poll).
      cvModule.onRuntimeInitialized = () => {
        window.clearTimeout(timeout)
        resolve()
      }

      tick()
    })

    return cvModule
  })()

  return cvPromise
}
