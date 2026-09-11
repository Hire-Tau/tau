export function amtpNodeCommand(executable: string, entrypoint: string, args: string[]): string[] {
  return [executable, entrypoint, ...args]
}
