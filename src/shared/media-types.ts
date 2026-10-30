import type { MediaFingerprint, MediaInfo, MediaKind, OptimiseReason } from '../engine/project/media'

/** Types for media import, generated files and the cache, shared by main, preload and renderer. */

export interface ProbedFile {
  path: string
  name: string
  kind: MediaKind
  info: MediaInfo
  fingerprint: MediaFingerprint
}

export type ProbeResult = { ok: true; file: ProbedFile } | { ok: false; path: string; error: string }

export type FileStatus = 'online' | 'offline' | 'changed'

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface OptimiseJob {
  id: string
  projectId: string
  mediaId: string
  name: string
  reasons: OptimiseReason[]
  status: JobStatus
  progress: number
  output: string | null
  error: string | null
}

export interface OptimiseRequest {
  projectId: string
  mediaId: string
  name: string
  path: string
  fingerprint: MediaFingerprint
  info: MediaInfo
  reasons: OptimiseReason[]
}

export interface GenerateRequest {
  projectId: string
  mediaId: string
  path: string
  kind: MediaKind
  fingerprint: MediaFingerprint
  durationSeconds: number
}

export const CACHE_CATEGORIES = ['thumbnails', 'waveforms', 'optimised', 'proxies', 'renders', 'analysis', 'bakes'] as const
export type CacheCategory = (typeof CACHE_CATEGORIES)[number]

export const CACHE_CATEGORY_LABELS: Record<CacheCategory, string> = {
  thumbnails: 'Thumbnails',
  waveforms: 'Waveforms',
  optimised: 'Optimised copies',
  proxies: 'Proxies',
  renders: 'Preview renders',
  analysis: 'Audio and motion analysis',
  bakes: 'Datamosh bakes'
}

export interface CacheProjectUsage {
  projectId: string
  name: string
  projectPath: string | null
  /** False when the project folder no longer exists (its cache is safe to remove). */
  projectExists: boolean
  lastUsed: string | null
  bytes: Record<CacheCategory, number>
  total: number
}
