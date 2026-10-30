import type { TestEffect } from '@shared/ipc'
import { formatTimecode, frameToTicks, nearestStandardRate } from '@engine/time'
import { collectDiagnostics, type Diagnostics } from '../diagnostics'
import { initGpu, type GpuContext } from '../gpu/gpu'
import { FramePipeline } from '../gpu/frame-pipeline'
import { Clip } from '../media/clip'
import { badge, clear, definitionList, el } from './dom'

/**
 * M0 diagnostics shell: proves WebGPU, WebCodecs and file access work on this Mac.
 * Open a clip, scrub it frame by frame, run it through the test shader, and measure
 * decode and GPU timings. The real editor workspace replaces this in M1.
 */
export async function runApp(root: HTMLElement): Promise<void> {
  const ui = buildLayout(root)
  const state = {
    gpu: null as GpuContext | null,
    pipeline: null as FramePipeline | null,
    context: null as GPUCanvasContext | null,
    format: 'bgra8unorm' as GPUTextureFormat,
    clip: null as Clip | null,
    index: 0,
    pendingIndex: null as number | null,
    decoding: false,
    playing: false,
    effect: 'none' as TestEffect,
    amount: 1
  }

  let gpuError: string | undefined
  try {
    state.gpu = await initGpu((reason) => setStatus(ui, `GPU device lost (${reason}). Reload the window with Cmd+R.`, true))
    state.pipeline = new FramePipeline(state.gpu.device)
    state.format = navigator.gpu.getPreferredCanvasFormat()
    const context = ui.canvas.getContext('webgpu')
    if (!context) throw new Error('Could not create a WebGPU canvas context.')
    context.configure({ device: state.gpu.device, format: state.format, alphaMode: 'opaque' })
    state.context = context
  } catch (error) {
    gpuError = (error as Error).message
    setStatus(ui, `WebGPU failed: ${gpuError}`, true)
  }

  const diagnostics = await collectDiagnostics(state.gpu, gpuError)
  renderDiagnostics(ui.diagnostics, diagnostics)

  const draw = (frame: VideoFrame): number => {
    if (!state.gpu || !state.pipeline || !state.context) return 0
    const start = performance.now()
    state.pipeline.draw(frame, state.context.getCurrentTexture().createView(), state.format, {
      effect: state.effect,
      amount: state.amount
    })
    return performance.now() - start
  }

  const showFrame = async (index: number): Promise<void> => {
    const clip = state.clip
    if (!clip) return
    if (state.decoding) {
      state.pendingIndex = index
      return
    }
    state.decoding = true
    try {
      const decodeStart = performance.now()
      const decoded = await clip.frameAt(index)
      const decodeMs = performance.now() - decodeStart
      if (!decoded) return
      try {
        draw(decoded.frame)
      } finally {
        decoded.frame.close()
      }
      const gpuStart = performance.now()
      await state.gpu?.device.queue.onSubmittedWorkDone()
      const gpuMs = performance.now() - gpuStart
      state.index = index
      updatePosition(ui, clip, index)
      ui.stats.textContent = `Decode ${decodeMs.toFixed(1)} ms · GPU ${gpuMs.toFixed(2)} ms`
    } catch (error) {
      setStatus(ui, (error as Error).message, true)
    } finally {
      state.decoding = false
      if (state.pendingIndex !== null) {
        const next = state.pendingIndex
        state.pendingIndex = null
        void showFrame(next)
      }
    }
  }

  const play = async (): Promise<void> => {
    const clip = state.clip
    if (!clip || state.playing) return
    state.playing = true
    ui.play.textContent = 'Stop'
    const fps = clip.info.fps || 30
    const frameMs = 1000 / fps
    let startWall = 0
    let startTimestamp = 0
    let drawn = 0
    let dropped = 0
    let lastStats = performance.now()
    try {
      for await (const decoded of clip.framesFrom(state.index)) {
        if (!state.playing) {
          decoded.frame.close()
          break
        }
        const now = performance.now()
        if (startWall === 0) {
          startWall = now
          startTimestamp = decoded.timestamp
        }
        const due = startWall + (decoded.timestamp - startTimestamp) * 1000
        if (now > due + frameMs) {
          dropped++
          decoded.frame.close()
          continue
        }
        if (due > now) await sleep(due - now)
        try {
          draw(decoded.frame)
        } finally {
          decoded.frame.close()
        }
        drawn++
        state.index = decoded.index
        updatePosition(ui, clip, decoded.index)
        if (performance.now() - lastStats > 250) {
          const elapsed = (performance.now() - startWall) / 1000
          ui.stats.textContent = `Playback ${(drawn / elapsed).toFixed(1)} fps of ${fps.toFixed(2)} · dropped ${dropped} · no audio in M0`
          lastStats = performance.now()
        }
      }
    } catch (error) {
      setStatus(ui, (error as Error).message, true)
    } finally {
      state.playing = false
      ui.play.textContent = 'Play'
    }
  }

  ui.open.addEventListener('click', async () => {
    const path = await window.ginosa.openMediaDialog()
    if (!path) return
    state.playing = false
    state.clip?.dispose()
    state.clip = null
    setStatus(ui, `Opening ${path}…`)
    try {
      const clip = await Clip.open(window.ginosa.mediaUrl(path))
      state.clip = clip
      renderClipInfo(ui.clipInfo, clip, path)
      ui.canvas.width = clip.info.width || 1920
      ui.canvas.height = clip.info.height || 1080
      ui.monitor.style.setProperty('--aspect', `${ui.canvas.width} / ${ui.canvas.height}`)
      ui.scrubber.max = String(Math.max(0, clip.info.frameCount - 1))
      ui.scrubber.value = '0'
      ui.scrubber.disabled = !clip.info.canDecode
      ui.play.disabled = !clip.info.canDecode
      if (clip.info.canDecode) {
        setStatus(ui, '')
        await showFrame(0)
      } else {
        setStatus(ui, `${clip.info.codec} can't be decoded by WebCodecs here. In M2 this file would get an optimised copy.`, true)
      }
    } catch (error) {
      setStatus(ui, `Couldn't open the file: ${(error as Error).message}`, true)
    }
  })

  ui.scrubber.addEventListener('input', () => {
    state.playing = false
    void showFrame(Number(ui.scrubber.value))
  })

  ui.play.addEventListener('click', () => {
    if (state.playing) state.playing = false
    else void play()
  })

  ui.effect.addEventListener('change', () => {
    state.effect = ui.effect.value as TestEffect
    ui.amount.disabled = state.effect === 'none'
    if (!state.playing) void showFrame(state.index)
  })

  ui.amount.addEventListener('input', () => {
    state.amount = Number(ui.amount.value) / 100
    ui.amountValue.textContent = `${ui.amount.value}%`
    if (!state.playing) void showFrame(state.index)
  })

  window.addEventListener('keydown', (event) => {
    if (!state.clip || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      state.playing = false
      const step = event.key === 'ArrowRight' ? 1 : -1
      const max = Math.max(0, state.clip.info.frameCount - 1)
      void showFrame(Math.min(max, Math.max(0, state.index + step)))
    } else if (event.key === ' ') {
      event.preventDefault()
      if (state.playing) state.playing = false
      else void play()
    }
  })
}

interface Ui {
  canvas: HTMLCanvasElement
  monitor: HTMLDivElement
  diagnostics: HTMLDivElement
  clipInfo: HTMLDivElement
  open: HTMLButtonElement
  play: HTMLButtonElement
  scrubber: HTMLInputElement
  effect: HTMLSelectElement
  amount: HTMLInputElement
  amountValue: HTMLSpanElement
  timecode: HTMLSpanElement
  stats: HTMLSpanElement
  status: HTMLDivElement
}

function buildLayout(root: HTMLElement): Ui {
  const v = window.ginosa.versions
  const canvas = el('canvas', { class: 'monitor-canvas', width: 1920, height: 1080 })
  const monitor = el('div', { class: 'monitor' }, canvas)
  const diagnostics = el('div', { class: 'panel-body' }, el('p', { class: 'muted', text: 'Checking this Mac…' }))
  const clipInfo = el('div', { class: 'panel-body' }, el('p', { class: 'muted', text: 'No clip open.' }))
  const open = el('button', { class: 'button primary', text: 'Open video…' })
  const play = el('button', { class: 'button', text: 'Play', disabled: true })
  const scrubber = el('input', { class: 'scrubber', type: 'range', min: 0, max: 0, value: 0, step: 1, disabled: true })
  const effect = el(
    'select',
    { class: 'select' },
    el('option', { value: 'none', text: 'No effect' }),
    el('option', { value: 'invert', text: 'Invert (test shader)' })
  )
  const amount = el('input', { class: 'slider', type: 'range', min: 0, max: 100, value: 100, disabled: true })
  const amountValue = el('span', { class: 'mono muted', text: '100%' })
  const timecode = el('span', { class: 'mono timecode', text: '00:00:00:00' })
  const stats = el('span', { class: 'mono muted', text: '' })
  const status = el('div', { class: 'status' })

  root.append(
    el(
      'header',
      { class: 'titlebar' },
      el('span', { class: 'wordmark', text: 'ginosa' }),
      el('span', { class: 'milestone', text: 'M0 · Foundations' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'mono muted', text: `Electron ${v.electron} · Chromium ${v.chrome}` })
    ),
    el(
      'main',
      { class: 'shell' },
      el(
        'aside',
        { class: 'sidebar' },
        el('section', { class: 'panel' }, el('h2', { text: 'This Mac' }), diagnostics),
        el('section', { class: 'panel' }, el('h2', { text: 'Clip' }), clipInfo)
      ),
      el(
        'section',
        { class: 'stage' },
        monitor,
        el(
          'div',
          { class: 'transport' },
          open,
          play,
          timecode,
          scrubber,
          el('span', { class: 'divider' }),
          effect,
          amount,
          amountValue
        ),
        el('div', { class: 'statusbar' }, stats, status)
      )
    )
  )

  return { canvas, monitor, diagnostics, clipInfo, open, play, scrubber, effect, amount, amountValue, timecode, stats, status }
}

function setStatus(ui: Ui, message: string, isError = false): void {
  ui.status.textContent = message
  ui.status.classList.toggle('error', isError)
}

function updatePosition(ui: Ui, clip: Clip, index: number): void {
  ui.scrubber.value = String(index)
  const rate = nearestStandardRate(clip.info.fps)
  ui.timecode.textContent = rate ? formatTimecode(frameToTicks(index, rate), rate) : `frame ${index}`
}

function renderDiagnostics(target: HTMLElement, d: Diagnostics): void {
  clear(target)
  const gpuRows: Array<[string, string | Node]> =
    'error' in d.gpu
      ? [['WebGPU', badge(false, 'ok', 'unavailable')], ['Reason', d.gpu.error]]
      : [
          ['WebGPU', badge(true, 'available')],
          ['GPU', [d.gpu.vendor, d.gpu.architecture, d.gpu.description].filter(Boolean).join(' · ') || 'unknown'],
          ['Max texture', `${d.gpu.limits['maxTextureDimension2D'] ?? '?'} px`],
          ['Timestamps', badge(d.gpu.deviceFeatures.includes('timestamp-query'))],
          ['16-bit shaders', badge(d.gpu.deviceFeatures.includes('shader-f16'))]
        ]
  target.append(definitionList(gpuRows))

  const codecList = (title: string, checks: Diagnostics['videoDecoders']): HTMLElement =>
    el(
      'div',
      { class: 'codec-group' },
      el('h3', { text: title }),
      definitionList(checks.map((check): [string, Node] => [check.name, badge(check.supported)]))
    )
  target.append(
    codecList('Hardware decode', d.videoDecoders),
    codecList('Hardware encode', d.videoEncoders),
    codecList('Audio decode', d.audioDecoders)
  )
}

function renderClipInfo(target: HTMLElement, clip: Clip, path: string): void {
  clear(target)
  const i = clip.info
  const name = path.split('/').pop() ?? path
  target.append(
    definitionList([
      ['File', name],
      ['Container', i.container],
      ['Codec', `${i.codec}${i.codecString ? ` (${i.codecString})` : ''}`],
      ['Decodable', badge(i.canDecode)],
      ['Size', `${i.width} × ${i.height}${i.rotation ? ` · rotated ${i.rotation}°` : ''}`],
      ['Frame rate', i.fps ? `${i.fps.toFixed(3)} fps` : 'unknown'],
      ['Frames', String(i.frameCount)],
      ['Duration', `${i.durationSeconds.toFixed(2)} s`],
      ['Bitrate', i.averageBitrate ? `${(i.averageBitrate / 1e6).toFixed(1)} Mb/s` : 'unknown'],
      ['Audio', i.audio ? `${i.audio.codec} · ${i.audio.sampleRate} Hz · ${i.audio.channels} ch` : 'none']
    ])
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
