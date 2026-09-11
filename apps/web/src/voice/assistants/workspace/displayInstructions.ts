import type { ArtifactContext, ArtifactIndexItem } from '../../../api/artifacts'

export function buildWorkspaceDisplayInstructions(
  artifact: ArtifactIndexItem | null,
  context?: ArtifactContext
): string {
  if (!artifact) {
    return [
      '## Current Voice Workspace Display',
      'No artifact is currently displayed in the workspace.',
      'If the user asks what is showing, say that nothing is displayed yet and offer to create something.',
    ].join('\n')
  }

  const manifest = context?.manifest
  const entry = manifest?.entry ?? artifact.entry
  const title = manifest?.title ?? artifact.title
  const summary = manifest?.summary ?? artifact.summary
  const status = manifest?.status ?? artifact.status
  const manifestPublishes = (
    manifest as (typeof manifest & { publishes?: ArtifactContext['history']['publishes'] }) | undefined
  )?.publishes
  const recentPublishes = (context?.history?.publishes ?? manifestPublishes ?? []).slice(-5).reverse()
  const publishLines =
    recentPublishes.length > 0
      ? ['Recent publishes:', ...recentPublishes.map((publish) => `- ${publish.at}: ${publish.changeSummary}`)]
      : ['Recent publishes: none recorded']

  return [
    '## Current Voice Workspace Display',
    'This is the artifact currently visible to the user in /voice.',
    `Title: ${title}`,
    `Artifact ID: ${artifact.artifactId}`,
    `Owning agent ID: ${artifact.agentId}`,
    `Status: ${status}`,
    `Entry type: ${entry?.type ?? 'none'}`,
    summary ? `Summary: ${summary}` : 'Summary: none',
    `Updated at: ${manifest?.updatedAt ?? artifact.updatedAt}`,
    ...publishLines,
    'If the user asks what this/current/latest/displayed artifact is or what changed recently, answer from this section before using tools.',
  ].join('\n')
}
