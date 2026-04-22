import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({
  component: About,
})

function About() {
  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell rounded-2xl p-6 sm:p-8">
        <p className="island-kicker mb-2">About</p>
        <h1 className="display-title mb-3 text-4xl font-bold text-[var(--sea-ink)] sm:text-5xl">
          Identity verification capture flow.
        </h1>
        <div className="max-w-3xl space-y-4 text-base leading-8 text-[var(--sea-ink-soft)]">
          <p className="m-0">
            This demo implements a guided, in-browser camera experience for:
          </p>
          <ul className="m-0 list-disc space-y-2 pl-6">
            <li>Capturing an ID document photo</li>
            <li>Capturing a selfie while holding the ID</li>
            <li>Reviewing both captures before submitting</li>
          </ul>
          <p className="m-0">
            During the session, a short background video recording may run for
            integrity/audit purposes (where supported).
          </p>
        </div>
      </section>

      <section className="island-shell mt-6 rounded-2xl p-6 sm:p-8">
        <p className="island-kicker mb-2">Integration</p>
        <h2 className="m-0 text-xl font-semibold text-[var(--sea-ink)] sm:text-2xl">
          Designed to plug into an existing system.
        </h2>
        <div className="mt-4 max-w-3xl space-y-4 text-sm leading-7 text-[var(--sea-ink-soft)]">
          <p className="m-0">
            This capture flow can run as a standalone page, or be embedded into
            an existing onboarding/KYC journey.
          </p>
          <ul className="m-0 list-disc space-y-2 pl-6">
            <li>
              <span className="font-semibold text-[var(--sea-ink)]">
                Drop-in route:
              </span>{' '}
              send users to <code className="font-mono">/verify</code> and
              return to your app after submission.
            </li>
            <li>
              <span className="font-semibold text-[var(--sea-ink)]">
                Embedded module:
              </span>{' '}
              mount the verifier inside an existing React app and wire callbacks
              (start, capture, retake, submit, cancel).
            </li>
            <li>
              <span className="font-semibold text-[var(--sea-ink)]">
                Isolated surface:
              </span>{' '}
              run it as an iframe/micro-frontend to keep camera + styling
              concerns contained.
            </li>
            <li>
              <span className="font-semibold text-[var(--sea-ink)]">
                Backend handshake:
              </span>{' '}
              use your existing auth/session system to issue a short-lived
              verification token and receive results via webhook or API.
            </li>
          </ul>
        </div>
      </section>

      <section className="island-shell mt-6 rounded-2xl p-6 sm:p-8">
        <p className="island-kicker mb-2">Improvements</p>
        <h2 className="m-0 text-xl font-semibold text-[var(--sea-ink)] sm:text-2xl">
          What could make this production-ready.
        </h2>
        <ul className="mt-4 mb-0 max-w-3xl list-disc space-y-2 pl-6 text-sm leading-7 text-[var(--sea-ink-soft)]">
          <li>
            Document edge detection + auto-crop, glare detection, and sharpness
            scoring to reduce retries.
          </li>
          <li>
            Optional liveness + spoof checks (blink/turn prompts, screen replay
            detection).
          </li>
          <li>
            OCR + validation (name/ID number/date formats) and barcode/MRZ
            extraction when available.
          </li>
          <li>
            Accessibility + localization (screen reader copy, keyboard support,
            multi-language prompts).
          </li>
          <li>
            Security + privacy controls (explicit consent, data retention rules,
            upload encryption, and configurable audit capture).
          </li>
          <li>
            Observability (capture funnel analytics, client error reporting, and
            device/browser compatibility insights).
          </li>
        </ul>
      </section>
    </main>
  )
}
