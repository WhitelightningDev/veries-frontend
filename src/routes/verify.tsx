import { createFileRoute } from '@tanstack/react-router'
import VerifyFlow from '../components/VerifyFlow'

export const Route = createFileRoute('/verify')({
  component: VerifyRoute,
})

function VerifyRoute() {
  return <VerifyFlow />
}
