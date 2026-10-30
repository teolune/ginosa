import { useEffect, useState } from 'react'
import { collectDiagnostics, type CodecCheck, type Diagnostics } from '../diagnostics'
import { getGpu } from '../gpu/shared'

function Badge({ ok, yes = 'yes', no = 'no' }: { ok: boolean; yes?: string; no?: string }) {
  return <span className={`badge ${ok ? 'ok' : 'no'}`}>{ok ? yes : no}</span>
}

function CodecList({ title, checks }: { title: string; checks: CodecCheck[] }) {
  return (
    <>
      <h3>{title}</h3>
      <dl className="kv">
        {checks.map((check) => (
          <div key={check.codec} className="kv-row">
            <dt>{check.name}</dt>
            <dd>
              <Badge ok={check.supported} />
            </dd>
          </div>
        ))}
      </dl>
    </>
  )
}

/** What this Mac's GPU and video hardware can do (the M0 checks). */
export function DiagnosticsWindow() {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  useEffect(() => {
    let cancelled = false
    getGpu()
      .then((gpu) => collectDiagnostics(gpu))
      .catch((error: Error) => collectDiagnostics(null, error.message))
      .then((result) => {
        if (!cancelled) setDiagnostics(result)
      })
    return () => {
      cancelled = true
    }
  }, [])
  if (!diagnostics) return <p className="muted pad">Checking this Mac…</p>
  const gpu = diagnostics.gpu
  const v = diagnostics.versions
  return (
    <div className="pad">
      <dl className="kv">
        <div className="kv-row">
          <dt>WebGPU</dt>
          <dd>
            <Badge ok={!('error' in gpu)} yes="available" no="unavailable" />
          </dd>
        </div>
        {'error' in gpu ? (
          <div className="kv-row">
            <dt>Reason</dt>
            <dd>{gpu.error}</dd>
          </div>
        ) : (
          <>
            <div className="kv-row">
              <dt>GPU</dt>
              <dd>{[gpu.vendor, gpu.architecture].filter(Boolean).join(' · ')}</dd>
            </div>
            <div className="kv-row">
              <dt>Max texture</dt>
              <dd>{gpu.limits['maxTextureDimension2D']} px</dd>
            </div>
            <div className="kv-row">
              <dt>16-bit shaders</dt>
              <dd>
                <Badge ok={gpu.deviceFeatures.includes('shader-f16')} />
              </dd>
            </div>
            <div className="kv-row">
              <dt>GPU timestamps</dt>
              <dd>
                <Badge ok={gpu.deviceFeatures.includes('timestamp-query')} />
              </dd>
            </div>
          </>
        )}
      </dl>
      <CodecList title="Hardware decode" checks={diagnostics.videoDecoders} />
      <CodecList title="Hardware encode" checks={diagnostics.videoEncoders} />
      <CodecList title="Audio decode" checks={diagnostics.audioDecoders} />
      <p className="muted small">
        Electron {v.electron} · Chromium {v.chrome}
      </p>
    </div>
  )
}
