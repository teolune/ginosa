import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Small JSON files in the app's settings folder (workspace layouts, recent projects). */
export class JsonFile {
  constructor(private readonly path: string) {}

  async read(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'))
    } catch {
      return null
    }
  }

  async write(data: unknown): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.tmp-${process.pid}`
    await writeFile(temp, JSON.stringify(data, null, 2), 'utf8')
    await rename(temp, this.path)
  }
}
