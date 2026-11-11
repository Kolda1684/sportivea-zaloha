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

/** True inside the packaged app: the bundled main process runs from app.asar. */
function isPackaged(): boolean {
  return fileURLToPath(import.meta.url).includes(`app.asar${sep}`)
}

export type FfprobeContext = { packaged: boolean; resourcesPath: string | undefined }

/**
 * Packaged: only `<resources>/bin/ffprobe` (ffprobe-static is excluded from the package), else a clear error.
 * Development: `resources/bin/ffprobe` up the tree, then ffprobe-static.
 */
export function locateFfprobe(ctx: FfprobeContext): string {
  if (ctx.packaged) {
    const packaged = ctx.resourcesPath ? join(ctx.resourcesPath, 'bin', 'ffprobe') : null
    if (packaged !== null && existsSync(packaged)) return packaged
    throw new Error(`ffprobe is missing from the app bundle (expected resources/bin/ffprobe${packaged ? ` at ${packaged}` : ''})`)
  }
  const bundled = bundledResource('ffprobe')
  if (bundled) return bundled
  const { path } = nodeRequire('ffprobe-static') as { path: string }
  return unpackedPath(path)
}

export function ffprobePath(): string {
  const override = process.env['TRIDENI_FFPROBE']
  if (override) return override
  // ffprobe-static's darwin/arm64 folder holds an x86_64 binary, so scripts/bundle-ffprobe.mjs (run by
  // `npm install` and `npm run app`) puts a self-contained arm64 ffprobe into resources/bin/.
  return locateFfprobe({ packaged: isPackaged(), resourcesPath: (process as ProcessWithResources).resourcesPath })
}
