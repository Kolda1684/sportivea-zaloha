import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendRecord, journalPath, type JournalRecord } from '../../../src/core/download/journal'
import { defaultStatfs, formatGb, fsTypeFromMount, makeStatfs, preflight } from '../../../src/core/download/preflight'
import type { DownloadPlan, PlanEntry } from '../../../src/core/download/types'

/** The temp dir is on the Mac's own disk: tests opt in to the Mac-disk check with `systemRoots`. */
const pf = (opts: Parameters<typeof preflight>[0]): ReturnType<typeof preflight> => preflight({ systemRoots: [], ...opts })

const GB = 1e9
const FOUR_GIB = 4_294_967_296

let chosenDir: string

beforeEach(async () => {
  chosenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-test-'))
})

afterEach(async () => {
  await fs.rm(chosenDir, { recursive: true, force: true })
})

const entry = (fileId: string, size: number | null, over: Partial<PlanEntry> = {}): PlanEntry => ({
  fileId,
  drivePath: `Zaloha/${fileId}.mp4`,
  localRelPath: `Zaloha/${fileId}.mp4`,
  kind: 'file',
  size,
  md5: 'd41d8cd98f00b204e9800998ecf8427e',
  mimeType: 'video/mp4',
  exportMime: null,
  modifiedTime: '2026-01-01T10:00:00.000Z',
  skipReason: null,
  blocked: false,
  duplicate: false,
  ...over,
})

const planOf = (entries: PlanEntry[]): DownloadPlan => ({
  rootName: 'Zaloha',
  entries,
  folders: ['Zaloha'],
  totalBytes: entries.reduce((s, e) => s + (e.size ?? 0), 0),
  fileCount: entries.length,
  duplicateCount: 0,
  duplicateBytes: 0,
})

const statfsOf =
  (freeBytes: number, type = 'apfs') =>
  async (): Promise<{ bavail: number; bsize: number; type: string }> => ({
    bavail: freeBytes / 4096,
    bsize: 4096,
    type,
  })

const record = (e: PlanEntry, over: Partial<JournalRecord> = {}): JournalRecord => ({
  fileId: e.fileId,
  localRelPath: e.localRelPath,
  size: e.size ?? 0,
  md5: e.md5,
  modifiedTime: e.modifiedTime,
  kind: 'file',
  localMtimeMs: 1,
  at: '2026-10-26T12:00:00.000Z',
  ...over,
})

describe('preflight state', () => {
  it('is new when destRoot does not exist', async () => {
    const r = await pf({ chosenDir, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
    expect(r).toEqual({
      destRoot: path.join(chosenDir, 'Zaloha'),
      state: 'new',
      lastRunAt: null,
      freeBytes: GB,
      neededBytes: 10,
      problem: null,
      warning: null,
    })
  })

  it('is new when destRoot exists but is empty or holds only .DS_Store / an empty .stahovani', async () => {
    const destRoot = path.join(chosenDir, 'Zaloha')
    await fs.mkdir(destRoot)
    await fs.writeFile(path.join(destRoot, '.DS_Store'), 'x')
    await fs.mkdir(path.join(destRoot, '.stahovani'))
    const r = await pf({ chosenDir, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
    expect(r.state).toBe('new')
    expect(r.problem).toBeNull()
  })

  it('is resume when a journal exists, with lastRunAt = newest record', async () => {
    const a = entry('a', 10)
    const b = entry('b', 20)
    const destRoot = path.join(chosenDir, 'Zaloha')
    await fs.mkdir(destRoot)
    await appendRecord(destRoot, record(a, { at: '2026-10-26T12:00:00.000Z' }))
    await appendRecord(destRoot, record(b, { at: '2026-10-27T08:30:00.000Z' }))
    await appendRecord(destRoot, record(entry('c', 1), { at: '2026-10-25T08:30:00.000Z' }))
    const r = await pf({ chosenDir, plan: planOf([a, b]), statfs: statfsOf(GB) })
    expect(r.state).toBe('resume')
    expect(r.lastRunAt).toBe('2026-10-27T08:30:00.000Z')
  })

  it('is resume with lastRunAt null for a journal without any valid record', async () => {
    const destRoot = path.join(chosenDir, 'Zaloha')
    await fs.mkdir(path.join(destRoot, '.stahovani'), { recursive: true })
    await fs.writeFile(journalPath(destRoot), 'garbage\n')
    const r = await pf({ chosenDir, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
    expect(r.state).toBe('resume')
    expect(r.lastRunAt).toBeNull()
  })

  it('is foreign when destRoot has content but no journal', async () => {
    const destRoot = path.join(chosenDir, 'Zaloha')
    await fs.mkdir(destRoot)
    await fs.writeFile(path.join(destRoot, 'cizi.txt'), 'x')
    const r = await pf({ chosenDir, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
    expect(r.state).toBe('foreign')
    expect(r.lastRunAt).toBeNull()
  })

  it('is foreign with a problem when destRoot is a file or a symlink', async () => {
    await fs.writeFile(path.join(chosenDir, 'Zaloha'), 'x')
    const r = await pf({ chosenDir, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
    expect(r.state).toBe('foreign')
    expect(r.problem).toMatch(/Zaloha/)

    await fs.rm(path.join(chosenDir, 'Zaloha'))
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-other-'))
    try {
      await fs.symlink(other, path.join(chosenDir, 'Zaloha'))
      const r2 = await pf({ chosenDir, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
      expect(r2.state).toBe('foreign')
      expect(r2.problem).toMatch(/Zaloha/)
    } finally {
      await fs.rm(other, { recursive: true, force: true })
    }
  })

  it('reports an unreadable journal as a problem instead of throwing', async () => {
    const destRoot = path.join(chosenDir, 'Zaloha')
    await fs.mkdir(path.join(destRoot, '.stahovani'), { recursive: true })
    await fs.symlink(path.join(chosenDir, 'nikam'), journalPath(destRoot))
    const r = await pf({ chosenDir, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
    expect(r.state).toBe('foreign')
    expect(r.problem).toMatch(/Žurnál/)
  })
})

describe('preflight damaged destination', () => {
  const DAMAGED =
    'Ve složce je poškozený záznam o stahování (.stahovani). Vyber jiné místo.'

  it('flags a .stahovani that is a regular file', async () => {
    const destRoot = path.join(chosenDir, 'Zaloha')
    await fs.mkdir(destRoot)
    await fs.writeFile(path.join(destRoot, '.stahovani'), 'x')
    const r = await pf({ chosenDir, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
    expect(r.state).toBe('foreign')
    expect(r.problem).toBe(DAMAGED)
  })

  it('flags a .stahovani that is a symlink, even to a directory with a journal', async () => {
    const destRoot = path.join(chosenDir, 'Zaloha')
    await fs.mkdir(destRoot)
    const elsewhere = path.join(chosenDir, 'elsewhere')
    await fs.mkdir(elsewhere)
    await fs.writeFile(path.join(elsewhere, 'journal.jsonl'), JSON.stringify(record(entry('a', 10))) + '\n')
    await fs.symlink(elsewhere, path.join(destRoot, '.stahovani'))
    const r = await pf({ chosenDir, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
    expect(r.state).toBe('foreign')
    expect(r.problem).toBe(DAMAGED)
    expect(r.neededBytes).toBe(10)
  })

  it('turns a disk I/O error into the unreadable-disk problem instead of rejecting', async () => {
    const destRoot = path.join(chosenDir, 'Zaloha')
    await fs.mkdir(destRoot)
    await fs.chmod(destRoot, 0o000)
    try {
      const r = await pf({ chosenDir, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
      expect(r.problem).toBe('Vybraný disk se nepodařilo přečíst. Zkontroluj, že je připojený.')
      expect(r.state).toBe('foreign')
    } finally {
      await fs.chmod(destRoot, 0o755)
    }
  })

  it('turns an unreadable journal file into the unreadable-disk problem', async () => {
    const destRoot = path.join(chosenDir, 'Zaloha')
    await appendRecordAt(destRoot)
    await fs.chmod(journalPath(destRoot), 0o000)
    try {
      const r = await pf({ chosenDir, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
      expect(r.problem).toBe('Vybraný disk se nepodařilo přečíst. Zkontroluj, že je připojený.')
    } finally {
      await fs.chmod(journalPath(destRoot), 0o644)
    }
  })
})

async function appendRecordAt(destRoot: string): Promise<void> {
  await fs.mkdir(destRoot)
  await appendRecord(destRoot, record(entry('a', 10)))
}

describe('preflight warning for unknown filesystem', () => {
  it('warns (without blocking) when the type is unknown and a file exceeds 4 GiB', async () => {
    const r = await pf({ chosenDir, plan: planOf([entry('a', 5e9)]), statfs: statfsOf(100 * GB, 'unknown') })
    expect(r.warning).toBe(
      'Nepodařilo se zjistit formát disku. Pokud je to FAT32, soubory nad 4 GB se nestáhnou.',
    )
    expect(r.problem).toBeNull()
  })

  it('has no warning when the type is unknown but all files are small', async () => {
    const r = await pf({
      chosenDir,
      plan: planOf([entry('a', FOUR_GIB - 1), entry('b', 10)]),
      statfs: statfsOf(100 * GB, 'unknown'),
    })
    expect(r.warning).toBeNull()
  })

  it('has no warning when the type is known', async () => {
    const r = await pf({ chosenDir, plan: planOf([entry('a', 5e9)]), statfs: statfsOf(100 * GB, 'apfs') })
    expect(r.warning).toBeNull()
  })
})

describe('preflight warning for a likely wrong destination', () => {
  const PREVIOUS = 'Vybraná složka vypadá jako cíl dřívějšího stahování. Pro navázání vyber složku o úroveň výš.'
  const MAC_DISK = 'Cíl je na disku Macu, ne na externím disku.'

  it('warns when the chosen folder holds a journal of its own (the old destination root was picked)', async () => {
    await appendRecord(chosenDir, record(entry('a', 10)))
    const r = await pf({ chosenDir, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
    expect(r.warning).toBe(PREVIOUS)
    expect(r.problem).toBeNull()
  })

  it('warns when the chosen folder has the root folder name, case-insensitively', async () => {
    const inner = path.join(chosenDir, 'ZALOHA')
    await fs.mkdir(inner)
    const r = await pf({ chosenDir: inner, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
    expect(r.warning).toBe(PREVIOUS)
    expect(r.problem).toBeNull()
  })

  it('warns when the destination is on the same volume as the system disk', async () => {
    const r = await pf({ chosenDir, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB), systemRoots: [os.tmpdir()] })
    expect(r.warning).toBe(MAC_DISK)
    expect(r.problem).toBeNull()
  })

  it('ignores a system root that cannot be read', async () => {
    const r = await pf({ chosenDir, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB), systemRoots: [path.join(chosenDir, 'nope')] })
    expect(r.warning).toBeNull()
  })

  it('joins several warnings with a space', async () => {
    await appendRecord(chosenDir, record(entry('a', 5e9)))
    const r = await pf({
      chosenDir,
      plan: planOf([entry('a', 5e9)]),
      statfs: statfsOf(100 * GB, 'unknown'),
      systemRoots: [os.tmpdir()],
    })
    expect(r.warning).toBe(`Nepodařilo se zjistit formát disku. Pokud je to FAT32, soubory nad 4 GB se nestáhnou. ${PREVIOUS} ${MAC_DISK}`)
  })

  it('checks the Mac disk by default', async () => {
    const r = await preflight({ chosenDir, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
    const dev = (await fs.stat(chosenDir)).dev
    const roots = await Promise.all(['/', '/System/Volumes/Data'].map((p) => fs.stat(p).then((st) => st.dev, () => null)))
    expect(r.warning === MAC_DISK).toBe(roots.includes(dev))
  })
})

describe('preflight neededBytes', () => {
  it('counts only file entries and reduces on resume when fileId and size match', async () => {
    const a = entry('a', 100)
    const b = entry('b', 200)
    const c = entry('c', 400)
    const exp = entry('d', null, { kind: 'export', md5: null })
    const skip = entry('e', null, { kind: 'skip', skipReason: 'zkratka' })
    const plan = planOf([a, b, c, exp, skip])
    const fresh = await pf({ chosenDir, plan, statfs: statfsOf(GB) })
    expect(fresh.neededBytes).toBe(700)

    const destRoot = path.join(chosenDir, 'Zaloha')
    await fs.mkdir(destRoot)
    await appendRecord(destRoot, record(a))
    await appendRecord(destRoot, record(b, { size: 199 })) // size differs: not done
    const resumed = await pf({ chosenDir, plan, statfs: statfsOf(GB) })
    expect(resumed.state).toBe('resume')
    expect(resumed.neededBytes).toBe(600)
  })
})

describe('preflight problems', () => {
  it('reports the shortfall in GB with a decimal comma', async () => {
    const plan = planOf([entry('a', 30 * GB)])
    const r = await pf({ chosenDir, plan, statfs: statfsOf(17.6 * GB) })
    expect(r.problem).toBe('Na disku chybí 12,4 GB.')
    expect(r.freeBytes).toBeCloseTo(17.6 * GB, -3)
    expect(r.neededBytes).toBe(30 * GB)
  })

  it('has no problem when the space is exactly enough', async () => {
    const r = await pf({ chosenDir, plan: planOf([entry('a', 5 * GB)]), statfs: statfsOf(5 * GB) })
    expect(r.problem).toBeNull()
  })

  it('refuses FAT32 when a file exceeds 4 GiB', async () => {
    const plan = planOf([entry('a', 5e9)])
    for (const type of ['msdos', 'MSDOS', 'fat32']) {
      const r = await pf({ chosenDir, plan, statfs: statfsOf(100 * GB, type) })
      expect(r.problem).toBe(
        'Disk je naformátovaný jako FAT32 a neunese soubory větší než 4 GB. Použij disk ve formátu exFAT nebo APFS.',
      )
    }
  })

  it('accepts FAT32 when every file fits and other formats with huge files', async () => {
    const small = planOf([entry('a', FOUR_GIB - 1)])
    expect((await pf({ chosenDir, plan: small, statfs: statfsOf(100 * GB, 'msdos') })).problem).toBeNull()
    const big = planOf([entry('a', 5e9)])
    for (const type of ['exfat', 'apfs', 'hfs']) {
      expect((await pf({ chosenDir, plan: big, statfs: statfsOf(100 * GB, type) })).problem).toBeNull()
    }
  })

  it('refuses a folder inside Google Drive for desktop', async () => {
    const cloud = path.join(chosenDir, 'Library', 'CloudStorage', 'GoogleDrive-a@b.cz', 'Muj disk')
    await fs.mkdir(cloud, { recursive: true })
    const r = await pf({ chosenDir: cloud, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
    expect(r.problem).toBe('Vyber externí disk, ne složku Google Disku.')
  })

  it('refuses a symlink that leads into CloudStorage', async () => {
    const cloud = path.join(chosenDir, 'Library', 'CloudStorage', 'GoogleDrive-a@b.cz')
    await fs.mkdir(cloud, { recursive: true })
    const link = path.join(chosenDir, 'odkaz')
    await fs.symlink(cloud, link)
    const r = await pf({ chosenDir: link, plan: planOf([entry('a', 10)]), statfs: statfsOf(GB) })
    expect(r.problem).toBe('Vyber externí disk, ne složku Google Disku.')
  })

  it('reports a problem when the volume cannot be read', async () => {
    const r = await pf({
      chosenDir,
      plan: planOf([entry('a', 10)]),
      statfs: async () => {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      },
    })
    expect(r.problem).toMatch(/disk/i)
    expect(r.freeBytes).toBe(0)
  })
})

describe('formatGb', () => {
  it('rounds up to one decimal with a comma', () => {
    expect(formatGb(12.4 * GB)).toBe('12,4')
    expect(formatGb(12.31 * GB)).toBe('12,4')
    expect(formatGb(1)).toBe('0,1')
    expect(formatGb(GB)).toBe('1,0')
    expect(formatGb(0.5 * GB)).toBe('0,5')
  })
})

describe('fsTypeFromMount', () => {
  const out = [
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
    '/dev/disk4s1 on /Volumes/KINGSTON (msdos, local, nodev, nosuid, noowners)',
    '/dev/disk5s2 on /Volumes/Zaloha (1) (exfat, local, nodev, nosuid, noowners)',
    '//user@host/share on /Volumes/share (smbfs, nodev, nosuid, mounted by user)',
  ].join('\n')

  it('picks the longest mount point that prefixes the directory', () => {
    expect(fsTypeFromMount('/Volumes/KINGSTON/Videa', out)).toBe('msdos')
    expect(fsTypeFromMount('/Volumes/KINGSTON', out)).toBe('msdos')
    expect(fsTypeFromMount('/Users/kolda/Desktop', out)).toBe('apfs')
    expect(fsTypeFromMount('/System/Volumes/Data/x', out)).toBe('apfs')
  })

  it('handles mount points with spaces and parentheses', () => {
    expect(fsTypeFromMount('/Volumes/Zaloha (1)/a', out)).toBe('exfat')
  })

  it('does not match a mount point that only shares a name prefix', () => {
    expect(fsTypeFromMount('/Volumes/KINGSTON2/a', out)).toBe('apfs')
    expect(fsTypeFromMount('/Volumes/KINGSTON2/a', '/dev/disk4s1 on /Volumes/KINGSTON (msdos, local)')).toBeNull()
  })

  it('returns null for empty or unrecognised output', () => {
    expect(fsTypeFromMount('/a', '')).toBeNull()
    expect(fsTypeFromMount('/a', 'nonsense')).toBeNull()
  })
})

describe('makeStatfs', () => {
  it("reports 'unknown' when mount fails or nothing matches, never the numeric type", async () => {
    const failing = makeStatfs(async () => {
      throw new Error('no mount')
    })
    expect((await failing(chosenDir)).type).toBe('unknown')
    const nomatch = makeStatfs(async () => '/dev/x on /nonexistent-mount (msdos, local)\n')
    expect((await nomatch(chosenDir)).type).toBe('unknown')
  })

  it('uses the mount type when it matches', async () => {
    const real = await fs.realpath(chosenDir)
    const found = makeStatfs(async () => `/dev/x on ${real} (exfat, local)\n`)
    expect((await found(chosenDir)).type).toBe('exfat')
  })
})

describe('defaultStatfs', () => {
  it('returns numeric space and a type string for a real directory', async () => {
    const s = await defaultStatfs(chosenDir)
    expect(s.bavail).toBeGreaterThan(0)
    expect(s.bsize).toBeGreaterThan(0)
    expect(typeof s.type).toBe('string')
    expect(s.type.length).toBeGreaterThan(0)
  })
})

describe('preflight: read-only destination', () => {
  it('refuses a disk that cannot be written to and names NTFS when that is the reason', async () => {
    const chosenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-ro-'))
    const plan = planOf([entry('a', 10)])
    const ntfs = await preflight({ chosenDir, plan, statfs: statfsOf(GB, 'ntfs'), systemRoots: [], writable: async () => false })
    expect(ntfs.problem).toBe(
      'Na tento disk nejde zapisovat. Je ve formátu NTFS (z Windows), do kterého Mac neumí zapisovat. Použij disk ve formátu exFAT nebo APFS.',
    )
    const other = await preflight({ chosenDir, plan, statfs: statfsOf(GB, 'apfs'), systemRoots: [], writable: async () => false })
    expect(other.problem).toBe('Na tento disk nejde zapisovat. Zkontroluj, že není zamčený nebo jen pro čtení.')
    const ok = await preflight({ chosenDir, plan, statfs: statfsOf(GB, 'apfs'), systemRoots: [], writable: async () => true })
    expect(ok.problem).toBeNull()
  })
})
