import { spawn } from 'child_process'

export async function openBrowser(
  url: string,
  options: {
    platform?: NodeJS.Platform
    spawn?: (args: string[]) => Promise<boolean>
  } = {}
): Promise<boolean> {
  const platform = options.platform ?? process.platform
  const args =
    platform === 'darwin'
      ? ['open', url]
      : platform === 'win32'
        ? ['rundll32', 'url.dll,FileProtocolHandler', url]
        : ['xdg-open', url]
  const run =
    options.spawn ??
    ((command: string[]) =>
      new Promise<boolean>((resolve) => {
        const child = spawn(command[0], command.slice(1), { detached: true, stdio: 'ignore' })
        child.once('error', () => resolve(false))
        child.once('spawn', () => {
          child.unref()
          resolve(true)
        })
      }))
  try {
    return await run(args)
  } catch {
    return false
  }
}
