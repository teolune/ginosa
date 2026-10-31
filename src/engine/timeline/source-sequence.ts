import { frameRateValue as mediaFrameRate, type MediaItem } from '../project/media'
import { createProject, type Sequence } from '../project/model'
import { FRAME_RATES, nearestStandardRate, type FrameRateName } from '../time'
import { applyPlace } from './edits'
import { EditContext } from './timeline'

/**
 * The Source Monitor plays a media file as a little sequence of its own, at the file's
 * size and frame rate: picture on V1 (fitted, so 100%) and sound on A1. The same
 * player, compositor and colour conversion as the Program monitor then apply.
 * Rates other than the standard ones (e.g. 120 fps slow motion) play at the nearest
 * standard rate, or 25 fps.
 */
export function sourceSequence(item: MediaItem): Sequence | null {
  if (item.kind === 'image') return null
  const video = item.info.video
  const rate = nearestStandardRate(mediaFrameRate(video?.frameRate ?? null))
  const frameRate = (Object.keys(FRAME_RATES) as FrameRateName[]).find((name) => FRAME_RATES[name] === rate) ?? '25'
  const sideways = Math.round(((video?.rotation ?? 0) % 360) / 90) % 2 !== 0
  const width = video ? (sideways ? video.height : video.width) : 1920
  const height = video ? (sideways ? video.width : video.height) : 1080
  let n = 0
  const createId = () => `source-${item.id}-${n++}`
  const project = createProject({ name: 'Source', settings: { width: Math.max(16, width), height: Math.max(16, height), frameRate }, createId, now: () => new Date(0) })
  const sequence = project.sequence
  const v1 = sequence.tracks.find((t) => t.kind === 'video')!
  const a1 = sequence.tracks.find((t) => t.kind === 'audio')!
  applyPlace(sequence, [item], { mediaId: item.id, sourceIn: 0, sourceOut: null, at: 0, videoTrackId: video ? v1.id : null, audioTrackId: item.info.audio ? a1.id : null, mode: 'overwrite' }, new EditContext(createId))
  return sequence
}
