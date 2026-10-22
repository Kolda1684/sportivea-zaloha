export type CardFile = {
  /** Path relative to the card root, always with `/` separators. */
  relPath: string
  absPath: string
  size: number
  kind: 'video' | 'other'
}
