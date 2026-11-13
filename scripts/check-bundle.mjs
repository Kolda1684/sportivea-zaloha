// Checks a packaged app before it goes to another Mac: valid ad-hoc signature, no dev-machine paths, no .env,
// OAuth secret only in the main bundle, runtime dependencies shipped. Exits 1 on the first failed check.
// Usage: node scripts/check-bundle.mjs "<path>/Sportivea Záloha.app"
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

const app = process.argv[2]
let failed = false
function check(name, fn) {
  try {
    const detail = fn()
    console.log(`OK   ${name}${detail ? ` (${detail})` : ''}`)
  } catch (e) {
    failed = true
    console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) return []
    return e.isDirectory() ? walk(p) : [p]
  })
}
function isMachO(file) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(4)
  fs.readSync(fd, buf, 0, 4, 0)
  fs.closeSync(fd)
  const magic = buf.readUInt32BE(0)
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)
}

if (!app || !fs.existsSync(path.join(app, 'Contents', 'Info.plist'))) {
  console.error(`FAIL not an app bundle: ${app ?? '(no path given)'}`)
  process.exit(1)
}
const resources = path.join(app, 'Contents', 'Resources')
const asarPath = path.join(resources, 'app.asar')

check('signature valid (codesign --verify --deep --strict)', () => {
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' })
})

check('bundled binaries load nothing from Homebrew, /usr/local or /Users', () => {
  const dirs = [path.join(resources, 'bin'), path.join(resources, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static')]
  let count = 0
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) throw new Error(`missing ${path.relative(app, dir)}`)
    for (const file of walk(dir)) {
      if (!isMachO(file)) continue
      count++
      const out = execFileSync('otool', ['-L', file], { encoding: 'utf8' })
      const bad = out.split('\n').slice(1).find((l) => /\/opt\/homebrew|\/usr\/local|\/Users\//.test(l))
      if (bad) throw new Error(`${path.relative(app, file)} -> ${bad.trim()}`)
    }
  }
  if (count === 0) throw new Error('no Mach-O files found')
  return `${count} files`
})

const entries = asar.listPackage(asarPath).map((p) => p.replace(/^\//, ''))

check('no .env file in the bundle', () => {
  const inAsar = entries.filter((p) => /(^|\/)\.env/.test(p))
  const outside = walk(app).filter((p) => /(^|\/)\.env/.test(path.basename(p)))
  if (inAsar.length + outside.length > 0) throw new Error([...inAsar, ...outside].join(', '))
})

function asarText(rel) {
  return asar.extractFile(asarPath, rel).toString('utf8')
}
const files = entries.filter((p) => {
  try {
    return asar.statFile(asarPath, p).size !== undefined && !('files' in asar.statFile(asarPath, p))
  } catch {
    return false
  }
})

check('OAuth secret only in out/main', () => {
  const leaks = files.filter((p) => /^out\/(preload|renderer)\//.test(p) && asarText(p).includes('GOCSPX'))
  if (leaks.length > 0) throw new Error(`found in ${leaks.join(', ')}`)
  const inMain = files.some((p) => p.startsWith('out/main/') && asarText(p).includes('GOCSPX'))
  if (!inMain) throw new Error('not in out/main: the build did not inject the OAuth values')
})

check('no /Users/kolda paths anywhere in app.asar', () => {
  const hits = files.filter((p) => asarText(p).includes('/Users/kolda'))
  if (hits.length > 0) throw new Error(hits.join(', '))
})

check('renderer bundle has no Node code (the sandboxed window would stay blank)', () => {
  const hits = files.filter((p) => p.startsWith('out/renderer/') && p.endsWith('.js') && /createRequire|require\("node:|from "node:/.test(asarText(p)))
  if (hits.length > 0) throw new Error(hits.join(', '))
})

check('runtime dependencies shipped', () => {
  for (const dep of ['node_modules/google-auth-library/package.json', 'node_modules/@anthropic-ai/sdk/package.json', 'node_modules/zod/package.json']) {
    if (!entries.includes(dep)) throw new Error(`missing ${dep}`)
  }
})

process.exit(failed ? 1 : 0)
