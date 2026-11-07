import { tracksOf } from '@engine/timeline/timeline'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'

/**
 * A track parameter (M14): None, or one of the sequence's video tracks. Datamosh's Motion
 * Source: the clips on that track move this picture. The track is read even while it's
 * hidden, so you can switch its eye off and see only the result.
 */
export function TrackControl({ value, onChange, disabled, label, ownTrackId }: { value: string; onChange(trackId: string): void; disabled: boolean; label: string; ownTrackId: string }) {
  useObservable(projectController)
  const tracks = projectController.project ? tracksOf(projectController.project.sequence, 'video') : []
  const missing = Boolean(value) && !tracks.some((t) => t.id === value)
  return (
    <select
      className="input compact track-control"
      aria-label={label}
      value={value}
      disabled={disabled}
      title={missing ? 'That track isn’t in this sequence any more, so the picture’s own motion is used' : value ? 'The clips on this track move the picture (their own effects aren’t applied)' : 'The picture’s own motion'}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">This picture</option>
      {tracks.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
          {t.id === ownTrackId ? ' (this clip’s track)' : ''}
          {t.visible ? '' : ' (hidden)'}
        </option>
      ))}
      {missing && <option value={value}>Missing track</option>}
    </select>
  )
}
