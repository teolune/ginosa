#!/usr/bin/env node
/**
 * ginosa agent runner: lets Claude run a fixed set of project commands on this Mac.
 *
 * Start it in its own Terminal tab with `npm run agent` and leave it running.
 * Claude drops a small JSON request into .agent/requests/; this script runs the
 * matching command (only the ones listed in TASKS below, never arbitrary shell),
 * prints what it is doing, and writes the output to .agent/results/.
 * Stop it any time with Ctrl+C.
 */
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const requestsDir = join(root, '.agent', 'requests')
const resultsDir = join(root, '.agent', 'results')
const POLL_MS = 400
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

// Plain values only: flags, numbers, file paths inside the project. No shell syntax.
const SAFE_ARG = /^[\w@./,:=+-]+$/
const SAFE_PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?$/i

const TASKS = {
  check: () => ['npm', ['run', 'check']],
  typecheck: () => ['npm', ['run', 'typecheck']],
  test: () => ['npm', ['run', 'test']],
  build: () => ['npm', ['run', 'build']],
  'test-media': () => ['npm', ['run', 'test-media']],
  doctor: () => ['npm', ['run', 'doctor']],
  install: () => ['npm', ['install']],
  'add-deps': (args) => {
    const dev = args[0] === '--dev'
    const packages = dev ? args.slice(1) : args
    if (packages.length === 0 || !packages.every((p) => SAFE_PACKAGE.test(p))) throw new Error('invalid package list')
    return ['npm', ['install', dev ? '--save-dev' : '--save', ...packages]]
  },
  render: (args) => {
    if (!args.every((a) => SAFE_ARG.test(a) && !a.includes('..'))) throw new Error('invalid render arguments')
    return ['npm', ['run', 'render', '--', ...args]]
  },
  snapshot: (args) => {
    if (!args.every((a) => SAFE_ARG.test(a) && !a.includes('..'))) throw new Error('invalid snapshot arguments')
    return ['npm', ['run', 'snapshot', '--', ...args]]
  },
  push: () => ['git', ['push']]
}

function stamp() {
  return new Date().toLocaleTimeString()
}

async function runRequest(file) {
  const id = file.replace(/\.json$/, '')
  const working = join(requestsDir, `${id}.running`)
  await rename(join(requestsDir, file), working)
  let request
  try {
    request = JSON.parse(await readFile(working, 'utf8'))
  } catch {
    await finish(id, working, { exitCode: -1, error: 'unreadable request' }, '')
    return
  }
  const task = TASKS[request.task]
  if (!task) {
    await finish(id, working, { exitCode: -1, error: `unknown task "${request.task}"` }, '')
    console.log(`[${stamp()}] refused unknown task "${request.task}"`)
    return
  }
  let command
  try {
    command = task(Array.isArray(request.args) ? request.args.map(String) : [])
  } catch (error) {
    await finish(id, working, { exitCode: -1, error: error.message }, '')
    console.log(`[${stamp()}] refused ${request.task}: ${error.message}`)
    return
  }
  const [bin, args] = command
  console.log(`[${stamp()}] running: ${bin} ${args.join(' ')}`)
  const started = Date.now()
  let output = ''
  const child = spawn(bin, args, { cwd: root, env: { ...process.env, FORCE_COLOR: '0' }, shell: false })
  child.stdout.on('data', (d) => (output += d))
  child.stderr.on('data', (d) => (output += d))
  const timeout = setTimeout(() => child.kill('SIGTERM'), Number(request.timeoutMs) || DEFAULT_TIMEOUT_MS)
  const exitCode = await new Promise((resolve) => child.on('close', (code) => resolve(code ?? -1)))
  clearTimeout(timeout)
  const durationMs = Date.now() - started
  console.log(`[${stamp()}] ${exitCode === 0 ? 'ok' : `failed (exit ${exitCode})`} in ${(durationMs / 1000).toFixed(1)} s`)
  await finish(id, working, { exitCode, durationMs, task: request.task, args: args }, output)
}

async function finish(id, working, result, output) {
  await writeFile(join(resultsDir, `${id}.log`), output)
  await writeFile(join(resultsDir, `${id}.json`), JSON.stringify({ id, ...result, finishedAt: new Date().toISOString() }, null, 2))
  await rm(working, { force: true })
}

async function main() {
  await mkdir(requestsDir, { recursive: true })
  await mkdir(resultsDir, { recursive: true })
  console.log('ginosa agent runner: waiting for requests from Claude (Ctrl+C to stop)')
  console.log(`allowed tasks: ${Object.keys(TASKS).join(', ')}`)
  let busy = false
  setInterval(async () => {
    if (busy) return
    busy = true
    try {
      const files = (await readdir(requestsDir)).filter((f) => f.endsWith('.json')).sort()
      for (const file of files) await runRequest(file)
    } catch (error) {
      console.error(`[${stamp()}] runner error: ${error.message}`)
    } finally {
      busy = false
    }
  }, POLL_MS)
}

main()
