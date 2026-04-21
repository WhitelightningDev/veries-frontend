import { createFileRoute } from '@tanstack/react-router'
import VerifyFlow from '../components/VerifyFlow'

export const Route = createFileRoute('/')({ component: App })

function App() {
  return <VerifyFlow />
}
