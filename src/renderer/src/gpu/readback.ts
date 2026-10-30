/** GPU texture -> PNG bytes, used by the render harness and later by image regression tests. */

export interface Readback {
  width: number
  height: number
  rgba: Uint8ClampedArray<ArrayBuffer>
}

export function createReadbackTarget(device: GPUDevice, width: number, height: number): GPUTexture {
  return device.createTexture({
    label: 'readback target',
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  })
}

export async function readTexture(device: GPUDevice, texture: GPUTexture): Promise<Readback> {
  const { width, height } = texture
  // copyTextureToBuffer needs rows padded to 256 bytes.
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256
  const buffer = device.createBuffer({
    label: 'readback buffer',
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  })
  const encoder = device.createCommandEncoder({ label: 'readback' })
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height])
  device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const padded = new Uint8Array(buffer.getMappedRange())
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let row = 0; row < height; row++) {
    rgba.set(padded.subarray(row * bytesPerRow, row * bytesPerRow + width * 4), row * width * 4)
  }
  buffer.unmap()
  buffer.destroy()
  return { width, height, rgba }
}

export async function encodePng(image: Readback): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('2D canvas unavailable for PNG encoding')
  context.putImageData(new ImageData(image.rgba, image.width, image.height), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return blob.arrayBuffer()
}
