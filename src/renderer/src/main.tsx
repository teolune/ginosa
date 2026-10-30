import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './app/App'
import { runHarness } from './harness/run-harness'

const params = new URLSearchParams(window.location.search)
const root = document.getElementById('app')

if (params.get('mode') === 'harness') {
  void runHarness()
} else if (root) {
  createRoot(root).render(<App />)
}
