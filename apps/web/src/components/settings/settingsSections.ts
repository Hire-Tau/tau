interface SectionItem {
  id: string
  label: string
  icon: string
  description: string
}

interface SectionGroup {
  label?: string
  items: readonly SectionItem[]
}

export const SECTION_GROUPS: readonly SectionGroup[] = [
  {
    label: 'Personal',
    items: [
      { id: 'account', label: 'Account', icon: '👤', description: 'Your profile, email, password, and passkeys.' },
      {
        id: 'app',
        label: 'App & Appearance',
        icon: '📱',
        description: 'Theme, app installation, cache, and offline storage.',
      },
      {
        id: 'notifications',
        label: 'Notifications',
        icon: '🔔',
        description: 'Your notification delivery and sound preferences.',
      },
      { id: 'devices', label: 'Paired Devices', icon: '🔗', description: 'Pair and manage linked devices.' },
      { id: 'sessions', label: 'Sessions', icon: '🔑', description: 'Active sign-in sessions and revocation.' },
    ],
  },
  {
    label: 'Work',
    items: [
      {
        id: 'workflows',
        label: 'Workflows',
        icon: '🔀',
        description: 'Reusable flows: participants, steps, handoffs, reviews, limits, and delivery policies.',
      },
      {
        id: 'agent-types',
        label: 'Agent Types',
        icon: '🤖',
        description: 'Agent expertise, model tiers, tools, skills, and permissions.',
      },
      {
        id: 'skills',
        label: 'Skills',
        icon: '🧩',
        description: 'Reusable agent instructions and supporting resources.',
      },
      {
        id: 'integrations',
        label: 'Integrations',
        icon: '🔌',
        description: 'Enable apps, connect accounts, and configure integration credentials and services.',
      },
    ],
  },
  {
    label: 'Access',
    items: [
      { id: 'users', label: 'Users', icon: '👥', description: 'Invite people and manage their access.' },
      { id: 'roles', label: 'Access Roles', icon: '🔐', description: 'Create and edit permission-based access roles.' },
      {
        id: 'system-tokens',
        label: 'System Tokens',
        icon: '🎟️',
        description: 'Issue and revoke API tokens with selected permissions.',
      },
      { id: 'signup', label: 'Sign-up', icon: '✉️', description: 'Registration policy and allowed email domains.' },
    ],
  },
  {
    label: 'Configuration',
    items: [
      {
        id: 'squad-presets',
        label: 'Squad Presets',
        icon: '👥',
        description: 'Starting templates copied into newly created squads.',
      },
      {
        id: 'git',
        label: 'Git',
        icon: '🔀',
        description: 'Default commit author identity and GitHub identity overrides.',
      },
      {
        id: 'notification-rules',
        label: 'Notification Rules',
        icon: '📋',
        description: 'Rules for routing events to outbound notifications.',
      },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      {
        id: 'providers',
        label: 'AI Providers',
        icon: '🧠',
        description: 'Connect model provider accounts and configure custom local providers.',
      },
      {
        id: 'memory',
        label: 'Assistant & Memory',
        icon: '🧠',
        description: 'Voice assistant and semantic memory search, including OpenAI API setup.',
      },
      { id: 'amtp', label: 'Federation', icon: '🌐', description: 'Federation identity, peers, and trust rules.' },
      {
        id: 'machines',
        label: 'Machines',
        icon: '🗄️',
        description: 'Machines and capacity used to run squad workloads.',
      },
      { id: 'remote-hosts', label: 'Remote hosts', icon: '🛰️', description: 'Shared SSH targets squads can access.' },
    ],
  },
  {
    label: 'Operations',
    items: [
      {
        id: 'system',
        label: 'System',
        icon: '🖥️',
        description: 'Runtime health, maximum active agents, maintenance, and process controls.',
      },
      { id: 'system-logs', label: 'Logs', icon: '📜', description: 'Search and inspect system logs.' },
      {
        id: 'ops-insights',
        label: 'Recommendations',
        icon: '⚡',
        description: 'Operational recommendations and optimization insights.',
      },
      { id: 'updates', label: 'Updates', icon: '⬆️', description: 'Update source, schedule, and deployment progress.' },
    ],
  },
] as const

export const ALL_SECTIONS = SECTION_GROUPS.flatMap((g) => g.items)
export type SectionId = (typeof ALL_SECTIONS)[number]['id']

const SECTION_IDS = ALL_SECTIONS.map((s) => s.id)

const SECRET_READ_PERMISSIONS = ['secrets:read', 'secrets:read:integration']

const SECTION_PERMISSIONS: Partial<Record<SectionId, string>> = {
  'ops-insights': 'recommendations:read',
  users: 'users:read',
  roles: 'roles:read',
  'system-tokens': 'system-tokens:manage',
  // Reading the policy exposes the allowed-domain list, which GET /auth/settings gates on settings:read.
  signup: 'settings:read',
  memory: 'settings:read',
  providers: 'provider-auth:read',
  skills: 'skills:read',
  'agent-types': 'agent-types:read',
  'squad-presets': 'squad-presets:read',
  workflows: 'workflows:read',
  'notification-rules': 'settings:read',
  amtp: 'amtp:read',
  machines: 'machines:read',
  'remote-hosts': 'remote-hosts:read',
  system: 'squads:read',
  'system-logs': 'system:logs',
  updates: 'updates:read',
}

export function isValidSection(value: string | null): value is SectionId {
  return value !== null && SECTION_IDS.includes(value)
}

export function isSectionAllowed(
  section: SectionId,
  can: (permission: string) => boolean,
  isLoading: boolean,
  integrationAllowed = false
): boolean {
  if (section === 'integrations') return !isLoading && integrationAllowed
  if (section === 'git') {
    if (isLoading) return false
    return SECRET_READ_PERMISSIONS.some((permission) => can(permission))
  }
  if (section === 'system') {
    if (isLoading) return false
    return ['settings:read', 'squads:read', 'system:restart', 'system:pause'].some((permission) => can(permission))
  }
  const permission = SECTION_PERMISSIONS[section]
  if (!permission) return true
  if (isLoading) return false
  return can(permission)
}
