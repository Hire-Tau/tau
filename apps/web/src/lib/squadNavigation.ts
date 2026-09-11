export const SQUAD_TABS = [
  { path: 'home', label: 'Home' },
  { path: 'agents', label: 'Chats' },
  { path: 'work', label: 'Work' },
  { path: 'activity', label: 'Activity' },
  { path: 'workspace', label: 'Workspace' },
  { path: 'memory', label: 'Memory' },
  { path: 'apps', label: 'Apps' },
  { path: 'schedules', label: 'Schedules' },
  { path: 'monitors', label: 'Monitors' },
  { path: 'relationships', label: 'Relationships' },
  { path: 'sharing', label: 'Sharing' },
  { path: 'graph', label: 'Graph' },
  { path: 'settings', label: 'Settings' },
] as const

export const SQUAD_SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', icon: '⚙️' },
  { id: 'context', label: 'Instructions', icon: '📝' },
  { id: 'workflows', label: 'Workflows', icon: '🔀' },
  { id: 'integrations', label: 'Integrations', icon: '🔌' },
  { id: 'notifications', label: 'Notifications', icon: '🔔' },
  { id: 'workspace', label: 'Workspace', icon: '📦' },
  { id: 'memory', label: 'Memory', icon: '🧠' },
  { id: 'access', label: 'Remote access', icon: '🔑' },
] as const

export function resolveSquadSettingsSection(section: string | null, target?: string | null): string {
  if (
    (!section || section === 'general') &&
    ['max-concurrent-work-streams', 'auto-park-grace-minutes', 'default-workflow'].includes(target ?? '')
  )
    return 'workflows'
  if (
    (!section || section === 'integrations') &&
    ['sandbox-github-identity', 'git-author-name', 'git-author-email'].includes(target ?? '')
  )
    return 'workspace'
  if ((!section || section === 'general') && target === 'host-workspace-directory') return 'workspace'
  return (
    (
      {
        policies: 'workflows',
        sandbox: 'workspace',
        environment: 'workspace',
        ssh: 'access',
        'remote-hosts': 'access',
      } as Record<string, string>
    )[section ?? ''] ??
    section ??
    'general'
  )
}

export const PRIMARY_SQUAD_TABS = new Set(['home', 'agents', 'work', 'activity'])
