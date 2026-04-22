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
    </main>
  )
}
