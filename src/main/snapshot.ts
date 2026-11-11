import { isAbsolute, resolve } from 'node:path'

/**
 * UI snapshot mode, for automated checks of the interface:
 *   npm run snapshot -- --out renders/ui/workspace.png --scenario workspace
 * The app starts with a throwaway settings folder and a temporary project, runs
 * the named scenario, saves a PNG of the window and quits. Your real recent
 * projects and workspace layouts are never touched.
 */
export interface SnapshotOptions {
  out: string
  scenario: string
  width: number
  height: number
}

export const SNAPSHOT_SCENARIOS = ['start', 'workspace', 'windows', 'settings', 'docked', 'recovery', 'recovered', 'media', 'source', 'cache', 'waveform', 'icons', 'timeline', 'drag', 'composite', 'playback', 'sync', 'speed', 'speeddialog', 'sourceplay', 'footage', 'footage2', 'exportsync', 'exportcolour', 'exportspeed', 'exporteffects', 'exportui', 'effectsgpu', 'effectsui', 'colour', 'logview', 'exportkeyframes', 'exportrampsync', 'keyframeswarning', 'keyframesui', 'keyframesgraph', 'analysis', 'modulation', 'modulationui', 'masksgpu', 'exportmasks', 'masksui', 'feedbackgpu', 'feedback', 'cacheui', 'followui', 'colourlightgpu', 'exportcolourlight', 'colourlightui', 'graingpu', 'exportgrain', 'grainui', 'posterize', 'rackui', 'gradientmapgpu', 'gradientui', 'gradientfidelity', 'lookgpu', 'exportlook', 'datamoshgpu', 'exportmosh', 'moshfootage', 'timelineperf', 'timelineperf4k', 'waveformzoom', 'waveformzoom2', 'effectsperf'] as const

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  const value = index === -1 ? undefined : argv[index + 1]
  return value && !value.startsWith('--') ? value : undefined
}

export function isSnapshotRun(argv: string[]): boolean {
  return argv.includes('--snapshot')
}

export function parseSnapshotArgs(argv: string[], cwd: string): SnapshotOptions {
  const scenario = flag(argv, '--scenario') ?? 'workspace'
  if (!(SNAPSHOT_SCENARIOS as readonly string[]).includes(scenario)) {
    throw new Error(`--scenario must be one of ${SNAPSHOT_SCENARIOS.join(', ')}`)
  }
  const outArg = flag(argv, '--out') ?? `renders/ui/${scenario}.png`
  const width = Number(flag(argv, '--width') ?? '1600')
  const height = Number(flag(argv, '--height') ?? '1000')
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 800 || height < 600) {
    throw new Error('--width and --height must be whole numbers of at least 800 × 600')
  }
  return { out: isAbsolute(outArg) ? outArg : resolve(cwd, outArg), scenario, width, height }
}
