import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/terms')({
  component: TermsRoute,
})

function TermsRoute() {
  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell rounded-2xl p-6 sm:p-8">
        <p className="island-kicker mb-2">Terms</p>
        <h1 className="display-title m-0 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
          Terms of Use
        </h1>
        <div className="mt-4 max-w-3xl space-y-4 text-sm leading-7 text-[var(--sea-ink-soft)]">
          <p className="m-0">
            This is placeholder copy. Replace it with your organization’s Terms
            of Use and effective date.
          </p>
          <p className="m-0">
            By using this verification flow, you confirm that you have the
            authority to submit the requested images and that the information
            you provide is accurate.
          </p>
          <p className="m-0">
            <Link
              to="/privacy"
              className="font-semibold text-[var(--lagoon-deep)] no-underline hover:underline"
            >
              Read the Privacy Policy
            </Link>
          </p>
        </div>
      </section>
    </main>
  )
}
