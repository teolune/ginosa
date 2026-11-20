import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'

/**
 * A channel parameter (M15): None, or one of the Channel Rack's channels. Datamosh Bake sets
 * off a moment (a bloom or a heal) on each of that channel's cubes.
 */
export function ChannelControl({ value, onChange, disabled, label }: { value: string; onChange(rowId: string): void; disabled: boolean; label: string }) {
  useObservable(projectController)
  const rows = projectController.project?.sequence.rack.rows ?? []
  const missing = Boolean(value) && !rows.some((r) => r.id === value)
  return (
    <select
      className="input compact track-control"
      aria-label={label}
      value={value}
      disabled={disabled}
      title={missing ? 'That channel isn’t in the Channel Rack any more' : value ? 'Each cube of this channel sets off a moment' : 'No channel'}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">None</option>
      {rows.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
          {r.enabled ? '' : ' (muted)'}
        </option>
      ))}
      {missing && <option value={value}>Missing channel</option>}
    </select>
  )
}
