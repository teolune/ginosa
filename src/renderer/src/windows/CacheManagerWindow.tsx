import { useCallback, useEffect, useState } from 'react'
import { CACHE_CATEGORIES, CACHE_CATEGORY_LABELS, type CacheCategory, type CacheProjectUsage, type OptimiseJob } from '@shared/media-types'
import { formatBytes } from '../media-panel/format'
import { mediaController } from '../state/media-controller'
import { projectController } from '../state/project-controller'
import { renderCache } from '../render-cache/render-cache'

const GB = 1024 ** 3
const LIMITS = [2, 5, 10, 20, 50, 100, 200]

/** Preview renders' size limit (all projects together): past it, the least recently used go first. */
function PreviewLimit({ onChange }: { onChange(): void }) {
  const [state, setState] = useState<{ limit: number; used: number } | null>(null)
  useEffect(() => {
    void window.ginosa.cache.previewLimit().then(setState)
  }, [])
  if (!state) return null
  const current = Math.round(state.limit / GB)
  const options = LIMITS.includes(current) ? LIMITS : [...LIMITS, current].sort((a, b) => a - b)
  return (
    <section className="cache-section cache-limit">
      <h3>Preview renders</h3>
      <div className="cache-limit-row">
        <span className="muted small">
          {formatBytes(state.used)} of
        </span>
        <select
          className="input compact"
          aria-label="Preview renders limit"
          value={current}
          onChange={async (event) => {
            const bytes = Number(event.target.value) * GB
            const evicted = await window.ginosa.cache.setPreviewLimit(bytes)
            renderCache.forget(evicted)
            setState(await window.ginosa.cache.previewLimit())
            onChange()
          }}
        >
          {options.map((gb) => (
            <option key={gb} value={gb}>
              {gb} GB
            </option>
          ))}
        </select>
        <span className="muted small">for all projects; past it, the least recently used previews are deleted first.</span>
      </div>
    </section>
  )
}

/** A button that asks for a second click before doing something irreversible. */
function ConfirmButton({ label, confirmLabel, onConfirm, disabled }: { label: string; confirmLabel: string; onConfirm(): void; disabled?: boolean }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(timer)
  }, [armed])
  return (
    <button
      className={`button compact ${armed ? 'danger' : ''}`}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else setArmed(true)
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  )
}

/** Where generated files live, how much space they take, and safe cleanup. Original media is never touched. */
export function CacheManagerWindow() {
  const [root, setRoot] = useState('')
  const [projects, setProjects] = useState<CacheProjectUsage[]>([])
  const [jobs, setJobs] = useState<OptimiseJob[]>([])
  const [moved, setMoved] = useState<string | null>(null)
  const currentId = projectController.project?.id ?? null

  const refresh = useCallback(async () => {
    const usage = await window.ginosa.cache.usage()
    setRoot(usage.root)
    setProjects(usage.projects)
    setJobs(await window.ginosa.media.jobs())
  }, [])

  useEffect(() => {
    void refresh()
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.ginosa.media.onJobUpdate(() => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        void refresh()
      }, 500)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [refresh])

  const clear = async (projectId: string, category: CacheCategory | 'all') => {
    await window.ginosa.cache.clear(projectId, category)
    if (projectId === currentId) {
      mediaController.recheckAll()
      if (category === 'all' || category === 'renders') renderCache.reload()
    }
    await refresh()
  }

  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued')
  const total = projects.reduce((sum, p) => sum + p.total, 0)

  return (
    <div className="cache-manager">
      <div className="cache-location">
        <div>
          <div className="muted small">Cache folder · {formatBytes(total)} in total</div>
          <div className="mono cache-path" title={root}>
            {root}
          </div>
        </div>
        <span className="spacer" />
        <button className="button compact" onClick={() => void window.ginosa.cache.reveal()}>
          Show in Finder
        </button>
        <button
          className="button compact"
          onClick={async () => {
            const result = await window.ginosa.cache.chooseLocation()
            if (result) {
              setMoved(result.previous)
              await refresh()
              mediaController.recheckAll()
            }
          }}
        >
          Change…
        </button>
        <button className="button compact" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {moved && <p className="small muted pad-x">New files now go to the folder above. The previous cache stays at {moved}; delete it in Finder if you no longer need it.</p>}
      <p className="small muted pad-x">Everything here can be regenerated. Clearing it only costs time. Your original media is never touched.</p>
      <PreviewLimit onChange={() => void refresh()} />

      {active.length > 0 && (
        <section className="cache-section">
          <h3>Optimised copies in progress</h3>
          {active.map((job) => (
            <div key={job.id} className="cache-job">
              <span className="item-name">{job.name}</span>
              <span className="status-progress wide">
                <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
                <em>{job.status === 'queued' ? 'Waiting…' : `${Math.round(job.progress * 100)}%`}</em>
              </span>
              <button className="button compact" onClick={() => void window.ginosa.media.cancelJob(job.id)}>
                Cancel
              </button>
            </div>
          ))}
        </section>
      )}

      {projects.length === 0 && <p className="muted pad-x">The cache is empty.</p>}
      {projects.map((project) => (
        <section key={project.projectId} className="cache-section">
          <div className="cache-project-head">
            <h3>{project.name}</h3>
            {project.projectId === currentId && <span className="status-pill ok">Open</span>}
            {!project.projectExists && <span className="status-pill warn" title={project.projectPath ?? ''}>Project not found</span>}
            <span className="spacer" />
            <span className="mono">{formatBytes(project.total)}</span>
            <span title="For a finished project: deletes everything ginosa made for it (thumbnails, waveforms, optimised copies, previews, analysis). The project file and your media stay. The open project is saved and closed first. Autosaves too: Cache › Clean Up Finished Project and Autosaves.">
              <ConfirmButton
                label="Clean Up Finished Project"
                confirmLabel="Delete all its cache? Click again"
                disabled={project.total === 0}
                onConfirm={() => void (project.projectId === currentId ? projectController.cleanUpFinished(false).then(() => refresh()) : clear(project.projectId, 'all'))}
              />
            </span>
          </div>
          <table className="cache-table">
            <tbody>
              {CACHE_CATEGORIES.filter((c) => project.bytes[c] > 0).map((category) => (
                <tr key={category}>
                  <td>{CACHE_CATEGORY_LABELS[category]}</td>
                  <td className="mono">{formatBytes(project.bytes[category])}</td>
                  <td>
                    <ConfirmButton label="Clear" confirmLabel="Click again" onConfirm={() => void clear(project.projectId, category)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}
