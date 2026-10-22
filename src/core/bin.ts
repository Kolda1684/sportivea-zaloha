import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Named nodeRequire: electron-vite injects its own `const require` into the bundled main process.
const nodeRequire = createRequire(import.meta.url)

interface ProcessWithResources {
  resourcesPath?: string
}

/** In a packaged app, binaries cannot be executed from inside app.asar. */
export function unpackedPath(p: string): string {
  const marker = `app.asar${sep}`
  return p.includes(marker) ? p.replace(marker, `app.asar.unpacked${sep}`) : p
}

/** Looks for `resources/bin/<name>` next to the packaged app or up the tree from this file (dev). */
function bundledResource(name: string): string | null {
  const resourcesPath = (process as ProcessWithResources).resourcesPath
  if (resourcesPath) {
    const packaged = join(resourcesPath, 'bin', name)
    if (existsSync(packaged)) return packaged
  }
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'resources', 'bin', name)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function ffmpegPath(): string {
  const override = process.env['TRIDENI_FFMPEG']
  if (override) return override
  const resolved = nodeRequire('ffmpeg-static') as string | null
  if (!resolved) throw new Error('ffmpeg-static has no binary for this platform')
  return unpackedPath(resolved)
}

export function ffprobePath(): string {
  const override = process.env['TRIDENI_FFPROBE']
  if (override) return override
  // ffprobe-static's darwin/arm64 folder holds an x86_64 binary, so the
  // postinstall script puts a real arm64 ffprobe into resources/bin/.
  const bundled = bundledResource('ffprobe')
  if (bundled) return bundled
  const { path } = nodeRequire('ffprobe-static') as { path: string }
  return unpackedPath(path)
}
