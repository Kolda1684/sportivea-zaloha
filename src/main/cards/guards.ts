import * as fs from 'node:fs/promises'
import * as path from 'node:path'

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function real(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p)
  } catch {
    return null
  }
}

/**
 * Real path of `target` if it exists and lies inside `rootDir` (symlinks resolved on both sides), otherwise null.
 * Used before anything is revealed in Finder.
 */
export async function resolveInsideRoot(rootDir: string | null, target: string): Promise<string | null> {
  if (rootDir === null || !path.isAbsolute(rootDir) || !path.isAbsolute(target)) return null
  const [r, t] = await Promise.all([real(rootDir), real(target)])
  if (r === null || t === null) return null
  return isInside(r, t) ? t : null
}

/**
 * The root folder may only be changed to the folder the user chose in the native dialog during this session
 * (or cleared, or left as it is). A renderer cannot point it at an arbitrary directory.
 */
export class RootFolderGuard {
  private picked: string | null = null

  /** Remember the folder returned by the dialog. */
  async recordPick(dir: string): Promise<void> {
    this.picked = (await real(dir)) ?? null
  }

  async allows(candidate: string | null, current: string | null): Promise<boolean> {
    if (candidate === null || candidate === current) return true
    if (this.picked === null) return false
    return (await real(candidate)) === this.picked
  }
}
