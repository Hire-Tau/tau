export interface DockerStdinExecutor {
  execWithStdin(sandboxId: string, args: string[], stdin: Buffer): Promise<Buffer>
}

/** Route file contents only through the identity-verified stdin execution boundary. */
export async function writeDockerFile(
  manager: DockerStdinExecutor,
  sandboxId: string,
  absolutePath: string,
  content: string
): Promise<void> {
  await manager.execWithStdin(sandboxId, ['tee', absolutePath], Buffer.from(content))
}
