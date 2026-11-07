import { useEffect, useState } from 'react'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'

const CHOOSE = '\u0000choose'

const nameOf = (file: string) => (file.split('/').pop() ?? file).replace(/\.cube$/i, '')

/**
 * A LUT parameter (decision 77): the LUTs already in the project's luts folder, None, and
 * Choose .cube…, which copies the file you pick into the project (the original isn't changed).
 */
export function LutControl({ value, onChange, disabled, label }: { value: string; onChange(file: string): void; disabled: boolean; label: string }) {
  useObservable(projectController)
  const path = projectController.path
  const [luts, setLuts] = useState<Array<{ name: string; file: string }> | null>(null)
  useEffect(() => {
    let live = true
    if (!path) setLuts([])
    else
      window.ginosa.media
        .listLuts(path)
        .then((list) => live && setLuts(list))
        .catch(() => live && setLuts([]))
    return () => {
      live = false
    }
  }, [path, value])
  const choose = async () => {
    if (!path) {
      projectController.showMessage('Save the project first: LUTs are copied into its folder, so the project carries them')
      return
    }
    const source = await window.ginosa.media.chooseLut('look')
    if (!source) return
    try {
      const lut = await window.ginosa.media.importLut(path, source)
      onChange(lut.file)
    } catch (error) {
      projectController.showMessage(`That LUT couldn't be used: ${(error as Error).message}`)
    }
  }
  const missing = Boolean(value) && luts !== null && !luts.some((l) => l.file === value)
  return (
    <select
      className="input compact lut-control"
      aria-label={label}
      value={value}
      disabled={disabled}
      title={missing ? `${nameOf(value)} isn't in the project's luts folder any more` : value ? `${value} in the project folder` : 'No LUT: the picture is unchanged'}
      onChange={(event) => (event.target.value === CHOOSE ? void choose() : onChange(event.target.value))}
    >
      <option value="">None</option>
      {(luts ?? []).map((l) => (
        <option key={l.file} value={l.file}>
          {l.name}
        </option>
      ))}
      {value && !(luts ?? []).some((l) => l.file === value) && <option value={value}>{missing ? `${nameOf(value)} (missing)` : nameOf(value)}</option>}
      <option value={CHOOSE}>Choose .cube…</option>
    </select>
  )
}
