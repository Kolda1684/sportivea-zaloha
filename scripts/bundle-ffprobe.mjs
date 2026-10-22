// Builds a self-contained arm64 ffprobe in resources/bin/ (ffprobe + lib/*.dylib).
//
// ffprobe-static ships an x86_64 binary in its darwin/arm64 folder, so we take the Homebrew
// arm64 ffprobe instead. That binary is dynamically linked to /opt/homebrew/... dylibs, which
// do not exist on the office Mac. This script copies ffprobe and every non-system dylib it
// depends on (recursively, via `otool -L`), rewrites all references to @loader_path and
// ad-hoc re-signs the result. Run from postinstall and before packaging (`npm run app`).
// Usage: node scripts/bundle-ffprobe.mjs [--require]   (env TRIDENI_FFPROBE_SOURCE overrides the source)
//   default (postinstall): when no arm64 ffprobe can be bundled, warn and exit 0 so `npm install` still works.
//   --require (`npm run app`): the same situations exit 1 — a package must never ship without ffprobe.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const required = process.argv.includes('--require')

/** Cannot bundle: a warning for postinstall, a hard failure for packaging. */
function cannotBundle(message) {
  if (required) {
    console.error(`bundle-ffprobe: ${message}. The app cannot be packaged without a bundled arm64 ffprobe.`)
    process.exit(1)
  }
  console.warn(`bundle-ffprobe: ${message}; skipping`)
  process.exit(0)
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  cannotBundle(`this host is ${process.platform}/${process.arch}, an arm64 Mac is needed`)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const binDir = join(root, 'resources', 'bin')
const libDir = join(binDir, 'lib')
const source = process.env['TRIDENI_FFPROBE_SOURCE'] ?? '/opt/homebrew/bin/ffprobe'

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

const isSystem = (p) => p.startsWith('/usr/lib/') || p.startsWith('/System/')

/** Dependencies listed by `otool -L` (without the file's own install name). */
function dependencies(file) {
  const lines = run('otool', ['-L', file]).split('\n').slice(1)
  const own = file.endsWith('.dylib') ? run('otool', ['-D', file]).split('\n')[1]?.trim() : undefined
  const deps = []
  for (const line of lines) {
    const match = /^\t(\S.*?) \(compatibility version/.exec(line)
    if (!match) continue
    const dep = match[1]
    if (dep === own || isSystem(dep)) continue
    if (!dep.startsWith('/')) throw new Error(`${file}: unsupported non-absolute dependency ${dep}`)
    deps.push(dep)
  }
  return deps
}

if (!existsSync(source)) {
  cannotBundle(`${source} not found; install Homebrew ffmpeg (brew install ffmpeg) for an arm64 ffprobe`)
}
const realSource = realpathSync(source)
const kind = run('file', ['-b', realSource])
if (!kind.includes('arm64')) {
  cannotBundle(`${realSource} is not arm64 (${kind.trim()})`)
}

rmSync(binDir, { recursive: true, force: true })
mkdirSync(libDir, { recursive: true })
const target = join(binDir, 'ffprobe')
copyFileSync(realSource, target)
chmodSync(target, 0o755)

// Breadth-first copy of every non-system dylib, keyed by file name.
const bundled = new Map() // name -> original real path
const queue = [target]
while (queue.length > 0) {
  const current = queue.shift()
  for (const dep of dependencies(current)) {
    const name = basename(dep)
    const real = realpathSync(dep)
    const seen = bundled.get(name)
    if (seen !== undefined) {
      if (seen !== real) throw new Error(`two different dylibs named ${name}: ${seen} and ${real}`)
      continue
    }
    bundled.set(name, real)
    const copyPath = join(libDir, name)
    copyFileSync(real, copyPath)
    chmodSync(copyPath, 0o755)
    queue.push(copyPath)
  }
}

// Rewrite references: ffprobe -> @loader_path/lib/<name>, dylibs -> @loader_path/<name>.
function rewrite(file, prefix, isDylib) {
  const args = []
  if (isDylib) args.push('-id', `@loader_path/${basename(file)}`)
  for (const dep of dependencies(file)) args.push('-change', dep, `${prefix}${basename(dep)}`)
  if (args.length > 0) run('install_name_tool', [...args, file])
}
rewrite(target, '@loader_path/lib/', false)
for (const name of bundled.keys()) rewrite(join(libDir, name), '@loader_path/', true)

// install_name_tool invalidates signatures; ad-hoc sign everything (arm64 refuses unsigned code).
for (const name of readdirSync(libDir)) run('codesign', ['--force', '--sign', '-', join(libDir, name)])
run('codesign', ['--force', '--sign', '-', target])

// Self-check: no Homebrew path left, binary runs.
for (const file of [target, ...readdirSync(libDir).map((n) => join(libDir, n))]) {
  const out = run('otool', ['-L', file])
  if (out.includes('/opt/homebrew') || out.includes('/usr/local')) throw new Error(`${file} still references Homebrew:\n${out}`)
}
const version = run(target, ['-version']).split('\n')[0]
console.log(`bundle-ffprobe: ${bundled.size} dylibs bundled into ${libDir}; ${version}`)
