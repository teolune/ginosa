import type { MediaItem } from '@engine/project/media'
import type { Clip as TimelineClip, Sequence } from '@engine/project/model'
import { ticksToSeconds, type Ticks } from '@engine/time'
import { topVideoClipAt } from '@engine/timeline/timeline'
import { Clip } from '../media/clip'
import { mediaController } from '../state/media-controller'

/**
 * The Program monitor's still frame (M3): the top visible video clip under the
 * playhead, fitted to the sequence frame. No blending, effects or playback; the
 * real compositor arrives in M4.
 */

export type PreviewStatus = { kind: 'empty' } | { kind: 'frame'; clip: TimelineClip } | { kind: 'message'; text: string }


function fit(ctx: CanvasRenderingContext2D, source: CanvasImageSource, width: number, height: number, rotation: number): void {
  const canvas = ctx.canvas
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const quarter = Math.round(rotation / 90) % 4
  const rotated = quarter % 2 === 1
  const w = rotated ? height : width
  const h = rotated ? width : height
  const scale = Math.min(canvas.width / w, canvas.height / h)
  ctx.save()
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((quarter * Math.PI) / 2)
  ctx.drawImage(source, (-width * scale) / 2, (-height * scale) / 2, width * scale, height * scale)
  ctx.restore()
}

export class FramePreview {
  private clips = new Map<string, Promise<Clip>>()
  private images = new Map<string, Promise<HTMLImageElement>>()
  private busy = false
  private pending: (() => Promise<void>) | null = null

  constructor(private readonly canvas: HTMLCanvasElement) {}

  private open(path: string): Promise<Clip> {
    let clip = this.clips.get(path)
    if (!clip) {
      clip = Clip.open(window.ginosa.mediaUrl(path))
      clip.catch(() => this.clips.delete(path))
      this.clips.set(path, clip)
      // Keep a few files open; close the oldest.
      if (this.clips.size > 4) {
        const [oldest] = this.clips.keys()
        if (oldest) {
          void this.clips.get(oldest)?.then((c) => c.dispose()).catch(() => undefined)
          this.clips.delete(oldest)
        }
      }
    }
    return clip
  }

  private image(path: string): Promise<HTMLImageElement> {
    let image = this.images.get(path)
    if (!image) {
      image = new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('The image could not be loaded'))
        img.src = window.ginosa.mediaUrl(path)
      })
      this.images.set(path, image)
    }
    return image
  }

  /** Shows the frame at `time`. Requests made while decoding collapse into the latest. */
  show(sequence: Sequence, media: MediaItem[], time: Ticks, onStatus: (status: PreviewStatus) => void): void {
    const job = async () => {
      const ctx = this.canvas.getContext('2d')
      if (!ctx) return
      const clip = topVideoClipAt(sequence, time)
      if (!clip) {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
        onStatus({ kind: 'empty' })
        return
      }
      const item = media.find((m) => m.id === clip.mediaId)
      if (!item) return
      const runtime = mediaController.get(item.id)
      const path = mediaController.playablePath(item)
      if (!path) {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
        const text = runtime.status === 'offline' ? `${item.name} is offline` : `${item.name}: optimised copy in progress`
        onStatus({ kind: 'message', text })
        return
      }
      const sourceSeconds = ticksToSeconds(clip.sourceIn + (time - clip.start))
      try {
        if (item.kind === 'image') {
          const img = await this.image(path)
          fit(ctx, img, img.naturalWidth, img.naturalHeight, 0)
        } else {
          const decoder = await this.open(path)
          const fps = decoder.info.fps > 0 ? decoder.info.fps : 25
          const index = Math.max(0, Math.min(decoder.info.frameCount - 1, Math.floor(sourceSeconds * fps + 1e-6)))
          const decoded = await decoder.frameAt(index)
          if (!decoded) return
          fit(ctx, decoded.frame, decoded.frame.displayWidth, decoded.frame.displayHeight, decoder.info.rotation)
          decoded.frame.close()
        }
        onStatus({ kind: 'frame', clip })
      } catch (error) {
        onStatus({ kind: 'message', text: `${item.name}: ${(error as Error).message}` })
      }
    }
    this.pending = job
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.busy) return
    this.busy = true
    while (this.pending) {
      const job = this.pending
      this.pending = null
      await job()
    }
    this.busy = false
  }

  dispose(): void {
    for (const clip of this.clips.values()) void clip.then((c) => c.dispose()).catch(() => undefined)
    this.clips.clear()
  }
}
