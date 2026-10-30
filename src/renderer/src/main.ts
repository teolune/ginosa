import './styles.css'
import { runHarness } from './harness/run-harness'
import { runApp } from './ui/app'

const params = new URLSearchParams(window.location.search)
const root = document.getElementById('app')

if (params.get('mode') === 'harness') {
  void runHarness()
} else if (root) {
  void runApp(root)
}
