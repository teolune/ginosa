/** WebGPU device setup. One device is shared by every part of the app. */

export interface GpuContext {
  adapter: GPUAdapter
  device: GPUDevice
  features: string[]
  hasTimestampQuery: boolean
}

export interface GpuAdapterSummary {
  vendor: string
  architecture: string
  device: string
  description: string
  features: string[]
  limits: Record<string, number>
}

const WANTED_FEATURES: GPUFeatureName[] = ['timestamp-query', 'shader-f16', 'float32-filterable', 'rg11b10ufloat-renderable']

const REPORTED_LIMITS = [
  'maxTextureDimension2D',
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxComputeWorkgroupStorageSize',
  'maxComputeInvocationsPerWorkgroup',
  'maxBindGroups'
] as const

export class GpuUnavailableError extends Error {}

export async function initGpu(onLost?: (reason: string) => void): Promise<GpuContext> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    throw new GpuUnavailableError('WebGPU is not available in this build of Chromium (navigator.gpu is missing).')
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new GpuUnavailableError('No WebGPU adapter was found.')

  const requiredFeatures = WANTED_FEATURES.filter((feature) => adapter.features.has(feature))
  const device = await adapter.requestDevice({ requiredFeatures })
  device.lost.then((info) => {
    onLost?.(`${info.reason}: ${info.message}`)
  })
  device.addEventListener('uncapturederror', (event) => {
    console.error('WebGPU error:', (event as GPUUncapturedErrorEvent).error.message)
  })

  return {
    adapter,
    device,
    features: [...device.features].map(String).sort(),
    hasTimestampQuery: device.features.has('timestamp-query')
  }
}

export function summariseAdapter(adapter: GPUAdapter): GpuAdapterSummary {
  // adapter.info is available in current Chromium; older builds lack it.
  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info
  const limits: Record<string, number> = {}
  for (const name of REPORTED_LIMITS) {
    limits[name] = Number(adapter.limits[name])
  }
  return {
    vendor: info?.vendor ?? 'unknown',
    architecture: info?.architecture ?? 'unknown',
    device: info?.device ?? '',
    description: info?.description ?? '',
    features: [...adapter.features].map(String).sort(),
    limits
  }
}
