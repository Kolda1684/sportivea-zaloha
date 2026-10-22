// ffprobe-static ships an x86_64 binary in its darwin/arm64 folder. On Apple Silicon
// we copy a real arm64 ffprobe into resources/bin/ (resolved first by src/core/bin.ts).
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin' || process.arch !== 'arm64') process.exit(0)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = '/opt/homebrew/bin/ffprobe'
const targetDir = join(root, 'resources', 'bin')
const target = join(targetDir, 'ffprobe')

if (!existsSync(source)) {
  console.warn(`postinstall: ${source} not found; install Homebrew ffmpeg (brew install ffmpeg) for an arm64 ffprobe`)
  process.exit(0)
}
const kind = execFileSync('file', ['-b', source], { encoding: 'utf8' })
if (!kind.includes('arm64')) {
  console.warn(`postinstall: ${source} is not arm64 (${kind.trim()}); skipping`)
  process.exit(0)
}
mkdirSync(targetDir, { recursive: true })
copyFileSync(source, target)
chmodSync(target, 0o755)
console.log(`postinstall: copied arm64 ffprobe to ${target}`)
