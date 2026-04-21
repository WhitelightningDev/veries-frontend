import { createFileRoute } from '@tanstack/react-router'
import CameraVerifier from '../components/CameraVerifier'

export const Route = createFileRoute('/verify')({
  component: VerifyRoute,
})

function VerifyRoute() {
  return (
    <main className="page-wrap px-4 pb-10 pt-10 sm:pt-14">
      <CameraVerifier />
    </main>
  )
}

