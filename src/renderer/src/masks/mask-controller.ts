import { projectController } from '../state/project-controller'
import { Observable } from '../state/observable'
import { workspaceController } from '../state/workspace'

/**
 * Which mask and shape are being edited (in the Masks window and on the Program monitor),
 * the selected pen-path point, and whether the outline shows on the monitor.
 */
class MaskController extends Observable {
  maskId: string | null = null
  shapeId: string | null = null
  /** Index of the selected pen-path point (Delete removes it). */
  point: number | null = null
  /** Draw the selected shape on the Program monitor for editing. */
  overlay = true
  /** The clip the mask is being edited on: with Follow clip, it's drawn where it lands on that clip. */
  clipId: string | null = null

  constructor() {
    super()
    // A mask or shape that's gone (undo, delete) is let go of.
    projectController.subscribe(() => {
      const masks = projectController.project?.sequence.masks ?? []
      const mask = masks.find((m) => m.id === this.maskId)
      if (this.maskId && !mask) this.select(masks[0]?.id ?? null)
      else if (mask && this.shapeId && !mask.shapes.some((s) => s.id === this.shapeId)) this.selectShape(mask.shapes[0]?.id ?? null)
      else if (mask && !this.shapeId && mask.shapes[0]) this.selectShape(mask.shapes[0].id)
    })
  }

  get mask() {
    return projectController.project?.sequence.masks.find((m) => m.id === this.maskId) ?? null
  }

  get shape() {
    return this.mask?.shapes.find((s) => s.id === this.shapeId) ?? null
  }

  select(maskId: string | null, shapeId: string | null = null): void {
    this.maskId = maskId
    const mask = this.mask
    this.shapeId = shapeId ?? mask?.shapes[0]?.id ?? null
    this.point = null
    this.notify()
  }

  selectShape(shapeId: string | null): void {
    this.shapeId = shapeId
    this.point = null
    this.notify()
  }

  selectPoint(index: number | null): void {
    this.point = index
    this.notify()
  }

  setOverlay(on: boolean): void {
    this.overlay = on
    this.notify()
  }

  setClip(clipId: string | null): void {
    this.clipId = clipId
    this.notify()
  }

  /** Opens a mask in the Masks window, with its outline on the monitor (on `clipId`, if it follows that clip). */
  edit(maskId: string, clipId: string | null = null): void {
    this.select(maskId)
    this.clipId = clipId
    this.overlay = true
    workspaceController.open('masks')
    workspaceController.focus('masks')
    this.notify()
  }
}

export const maskController = new MaskController()
