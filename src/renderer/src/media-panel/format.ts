import { frameRateValue, type MediaItem } from '@engine/project/media'
import { formatTimecode, nearestStandardRate, secondsToTicks } from '@engine/time'

/** Video: timecode at the clip's own rate. Audio has no frames: hh:mm:ss.hundredths. */
export function formatMediaTime(item: MediaItem, seconds: number): string {
  const rate = item.info.video ? nearestStandardRate(frameRateValue(item.info.video.frameRate)) : null
  if (rate && item.kind !== 'image') return formatTimecode(secondsToTicks(seconds), rate)
  const hundredths = Math.round(seconds * 100)
  const hours = Math.floor(hundredths / 360000)
  const minutes = Math.floor(hundredths / 6000) % 60
  const secs = (hundredths % 6000) / 100
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`
}

export function formatDuration(item: MediaItem): string {
  if (item.kind === 'image') return 'Still'
  return formatMediaTime(item, item.info.durationSeconds)
}

export function formatFps(item: MediaItem): string {
  const fps = frameRateValue(item.info.video?.frameRate ?? null)
  if (!fps || item.kind === 'image') return ''
  return `${Number.isInteger(fps) ? fps : fps.toFixed(3)}${item.info.video?.variableFrameRate ? ' VFR' : ''}`
}

export function formatSize(item: MediaItem): string {
  const video = item.info.video
  if (video) return `${video.width}×${video.height}`
  const audio = item.info.audio
  return audio ? `${(audio.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz` : ''
}

export function formatCodec(item: MediaItem): string {
  const video = item.info.video
  if (video && item.kind !== 'image') {
    const depth = video.bitDepth && video.bitDepth > 8 ? ` ${video.bitDepth}-bit` : ''
    return `${video.codec.toUpperCase()}${depth}${video.hdr ? ` ${video.hdr.toUpperCase()}` : ''}`
  }
  if (video) return video.codec.toUpperCase()
  return item.info.audio?.codec.toUpperCase() ?? ''
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}
