import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/privacy')({
  component: PrivacyRoute,
})

function PrivacyRoute() {
  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell rounded-2xl p-6 sm:p-8">
        <p className="island-kicker mb-2">Privacy</p>
        <h1 className="display-title m-0 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
          Privacy Policy
        </h1>
        <div className="mt-4 max-w-3xl space-y-4 text-sm leading-7 text-[var(--sea-ink-soft)]">
          <p className="m-0">
            This is placeholder copy. Replace it with your organization’s
            Privacy Policy, including what data is collected, how it is used,
            how long it is retained, and how a user can request deletion.
          </p>
          <p className="m-0">
            Verification images can be sensitive personal data. Ensure
            encryption in transit/at rest and strict access controls in
            production.
          </p>
          <p className="m-0">
            <Link
              to="/terms"
              className="font-semibold text-[var(--lagoon-deep)] no-underline hover:underline"
            >
              Read the Terms of Use
            </Link>
          </p>
        </div>
      </section>
    </main>
  )
}
