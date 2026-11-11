import { ffmpegPath, ffprobePath } from '../../core/cards/bin'
import { runBinary } from '../../core/cards/exec'

export type ToolsDeps = {
  run?: (bin: string, args: string[]) => Promise<Buffer>
  ffprobe?: () => string
  ffmpeg?: () => string
  log?: (message: string) => void
}

/** Runs `ffprobe -version` and `ffmpeg -version` once. false: the app cannot analyse clips and must not start runs. */
export async function checkTools(deps: ToolsDeps = {}): Promise<boolean> {
  const run = deps.run ?? ((bin: string, args: string[]) => runBinary(bin, args))
  const tools: Array<[string, () => string]> = [
    ['ffprobe', deps.ffprobe ?? ffprobePath],
    ['ffmpeg', deps.ffmpeg ?? ffmpegPath],
  ]
  for (const [name, locate] of tools) {
    try {
      await run(locate(), ['-version'])
    } catch (e) {
      deps.log?.(`${name} check failed: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }
  return true
}
