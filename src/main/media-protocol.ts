import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { MEDIA_SCHEME, pathFromMediaUrl } from '@shared/ipc'
import { parseRange } from '@shared/range'

/**
 * Must run before app 'ready'. Makes the scheme behave like https for fetch(),
 * streaming and CORS, so Mediabunny's UrlSource can read files with range requests.
 */
export function registerMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        bypassCSP: true
      }
    }
  ])
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg'
}

// The renderer page (file:// or the dev server) is a different origin from this scheme.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges'
}

function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * Serves local files read-only. Originals are only ever opened for reading here;
 * nothing in this handler can write, move or delete a file.
 */
export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Read-only', { status: 405, headers: CORS_HEADERS })
    }
    const path = pathFromMediaUrl(request.url)
    if (!path || !isAbsolute(path)) {
      return new Response('Bad media URL', { status: 400 })
    }

    let size: number
    try {
      const info = await stat(path)
      if (!info.isFile()) return new Response('Not a file', { status: 404 })
      size = info.size
    } catch {
      return new Response('File not found', { status: 404 })
    }

    const baseHeaders: Record<string, string> = {
      ...CORS_HEADERS,
      'Accept-Ranges': 'bytes',
      'Content-Type': mimeFor(path),
      'Cache-Control': 'no-store'
    }

    const range = parseRange(request.headers.get('range'), size)
    if (range === 'invalid') {
      return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` } })
    }

    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(size) } })
    }

    if (range) {
      const { start, end } = range
      const stream = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream<Uint8Array>
      return new Response(stream, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`
        }
      })
    }

    const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>
    return new Response(stream, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(size) } })
  })
}
