import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanSourceForRawColors, type RawColorCategory } from './no-raw-colors.scanner'

// No-raw-colors guard (phase 1 of the color-theme architecture; report §7 row 1).
//
// New UI colors must flow through theme tokens (CSS custom properties mapped to
// Tailwind semantic utilities). This guard fails on NEW violations only: the
// allowlist below is the quantified pre-tokenization inventory from research
// work stream #215 (report §2.4, artifact
// artifacts/color-theme-investigation/report.md), re-derived against this tree
// (main @ d0610e293, 2026-09-16) so the guard passes on main as-is.
//
// The allowlist ONLY EVER SHRINKS: when phases 2–4 migrate a surface onto
// tokens, remove its entry here in the same PR. Entries that are documented
// exception-policy surfaces (report §4.3) are annotated inline instead of
// being migrated — EXCEPT brand assets, which are temporary pending
// tokenization per owner decision PD-5, not permanent exceptions.
//
// Inventory cross-check at guard introduction (current tree vs report §2.4 at
// 417a6c3f): palette utilities 1,936/150 vs 1,935/149 (tree drift), literal
// hex 190/20 vs 234/20 (44 chrome-token hexes moved to channel form by phase
// 0), color functions 101/6 vs 118/7 (SquadAgentThreads.css color-mix calls
// became token-wrapped; FileUpload.tsx inline styles were removed upstream),
// color-bearing inline styles 2/2 vs ~3 (MessageContent.tsx was cleaned
// upstream; PullToRefresh.tsx carries a brand purple).

type RawCategoryType = RawColorCategory
const srcRoot = join(import.meta.dir)

function isTestArtifact(path: string): boolean {
  return (
    path.endsWith('.test.ts') ||
    path.endsWith('.test.tsx') ||
    path.endsWith('.spec.ts') ||
    path.endsWith('.spec.tsx') ||
    path.endsWith('.fixture.ts') ||
    path.endsWith('.fixture.tsx') ||
    path.includes('/test/') ||
    path.includes('/tests/') ||
    path.includes('/fixtures/') ||
    path.includes('/__tests__/') ||
    path.includes('test-setup')
  )
}

// ---------------------------------------------------------------------------
// Allowlist: legacy inventory (phases 2–4 migrate these onto tokens)
// ---------------------------------------------------------------------------

const LEGACY_PALETTE_UTILITY_FILES: readonly string[] = [
  'components/ActionCenterContent.tsx',
  'components/ActionItem.tsx',
  'components/AgentChat.tsx',
  'components/AgentConversationBody.tsx',
  'components/AgentQuestionCard.tsx',
  'components/AgentSandboxControls.tsx',
  'components/AgentViewTabs.tsx',
  'components/AmtpAllowRulesEditor.tsx',
  'components/AmtpMailboxSection.tsx',
  'components/AppNav.tsx',
  'components/AssistantConversationView.tsx',
  'components/AssistantConversations.tsx',
  'components/Badge.tsx',
  'components/Chat.tsx',
  'components/ChatDrawer.tsx',
  'components/ChatPage.tsx',
  'components/ChatView.tsx',
  'components/ConfirmButton.tsx',
  'components/DevBackendBar.tsx',
  'components/FeedVisitSummary.tsx',
  'components/LoginPage.tsx',
  'components/MaintenanceBanner.tsx',
  'components/MarkdownContent.tsx',
  'components/MessageContent.tsx',
  'components/OfflineBanner.tsx',
  'components/QuestionInput.tsx',
  'components/RejectionModal.tsx',
  'components/RewindModal.tsx',
  'components/SchemaFieldInput.tsx',
  'components/SettingsPage.tsx',
  'components/SquadDetailPage.tsx',
  'components/SquadWorkspaceImageViewer.tsx',
  'components/UpdateBanner.tsx',
  'components/VoiceFormFillButton.tsx',
  'components/VoiceMicButton.tsx',
  'components/VoiceWorkspacePage.tsx',
  'components/WorkStreamApprovalConfirmation.tsx',
  'components/WorkStreamDetailModal.tsx',
  'components/WorkStreamFileCard.tsx',
  'components/WorkStreamGraph.tsx',
  'components/WorkStreamPauseControls.tsx',
  'components/WorkflowGraph.tsx',
  'components/WorkflowRunPanel.tsx',
  'components/WorktreeCleanupSettings.tsx',
  'components/artifacts/ArtifactRenderer.tsx',
  'components/artifacts/PresentationRenderer.tsx',
  'components/auth/DemoAccessPage.tsx',
  'components/auth/PasskeyLogin.tsx',
  'components/auth/PasskeyRecoveryRequest.tsx',
  'components/auth/PasskeyRegister.tsx',
  'components/auth/TokenRegisterPage.tsx',
  'components/integrations/BigbrainIntegrationSettings.tsx',
  'components/integrations/ConnectionAssignmentPicker.tsx',
  'components/integrations/GitHubIntegrationSettings.tsx',
  'components/integrations/IntegrationCredentialSettings.tsx',
  'components/integrations/NotionIntegrationSettings.tsx',
  'components/integrations/OAuthCallbackPage.tsx',
  'components/monitors/AgentMonitorsPanel.tsx',
  'components/monitors/MonitorDetailsModal.tsx',
  'components/monitors/MonitorsList.tsx',
  'components/onboarding/FirstSquadStep.tsx',
  'components/onboarding/InviteTeamStep.tsx',
  'components/onboarding/OnboardingPage.tsx',
  'components/onboarding/onboardingItemPresentation.ts',
  'components/schedules/CreateScheduleModal.tsx',
  'components/schedules/SchedulesList.tsx',
  'components/settings/AgentTypesSection.tsx',
  'components/settings/AmtpSection.tsx',
  'components/settings/ChannelsSection.tsx',
  'components/settings/DeviceAuthorizationApproval.tsx',
  'components/settings/DevicesSection.tsx',
  'components/settings/IntegrationsSection.tsx',
  'components/settings/InviteUserForm.tsx',
  'components/settings/LinkedChatAccounts.tsx',
  'components/settings/MachinesSection.tsx',
  'components/settings/MigrateControl.tsx',
  'components/settings/NotificationPreferences.tsx',
  'components/settings/NotificationsConfigSection.tsx',
  'components/settings/ProviderAuthSection.tsx',
  'components/settings/PublicKeyBlock.tsx',
  'components/settings/RebalancePanel.tsx',
  'components/settings/RemoteHostsSection.tsx',
  'components/settings/RolesSection.tsx',
  'components/settings/RotationCallout.tsx',
  'components/settings/SecretsSection.tsx',
  'components/settings/SessionsSection.tsx',
  'components/settings/SharedPromptPicker.tsx',
  'components/settings/SharedPromptsTab.tsx',
  'components/settings/SignupPolicySection.tsx',
  'components/settings/SkillsSection.tsx',
  'components/settings/SquadPresetsSection.tsx',
  'components/settings/SystemLogsSection.tsx',
  'components/settings/SystemTokensSection.tsx',
  'components/settings/SystemUpdateSection.tsx',
  'components/settings/TemplateDiffDialog.tsx',
  'components/settings/TemplateFieldActions.tsx',
  'components/settings/UsersSection.tsx',
  'components/settings/ViewportDebugSection.tsx',
  'components/squads/ActivityFeedView.tsx',
  'components/squads/AgentContextPanel.tsx',
  'components/squads/AgentInboxPanel.tsx',
  'components/squads/AgentVisualization.tsx',
  'components/squads/AgentWorkStreamsPanel.tsx',
  'components/squads/CreateFlowWorkStream.tsx',
  'components/squads/CreateHostWorkspaceField.tsx',
  'components/squads/CreateSquadModal.tsx',
  'components/squads/DeleteSquadModal.tsx',
  'components/squads/DirectMergePolicySettings.tsx',
  'components/squads/EventRulePredicates.tsx',
  'components/squads/EventRulePreview.tsx',
  'components/squads/ExternalDeploymentsPanel.tsx',
  'components/squads/IntegrationSettings.tsx',
  'components/squads/LocalDeploymentsPanel.tsx',
  'components/squads/MemorySettings.tsx',
  'components/squads/MemorySyncSettings.tsx',
  'components/squads/NotificationSettings.tsx',
  'components/squads/OrgGraph.tsx',
  'components/squads/RelationshipsList.tsx',
  'components/squads/RemoteHostsSettings.tsx',
  'components/squads/SandboxLogs.tsx',
  'components/squads/SandboxSettings.tsx',
  'components/squads/SandboxStatusIndicator.tsx',
  'components/squads/SpawnAgentModal.tsx',
  'components/squads/SquadAgentContextEditor.tsx',
  'components/squads/SquadAgentThreads.tsx',
  'components/squads/SquadAvatarSettings.tsx',
  'components/squads/SquadContextEditor.tsx',
  'components/squads/SquadEnvConfig.tsx',
  'components/squads/SquadEventRulesEditor.tsx',
  'components/squads/SquadGeneralSettings.tsx',
  'components/squads/SquadGitIdentitySettings.tsx',
  'components/squads/SquadIntegrationCard.tsx',
  'components/squads/SquadList.tsx',
  'components/squads/SquadSshConfig.tsx',
  'components/squads/SquadSshKeys.tsx',
  'components/squads/SquadUniverse.tsx',
  'components/squads/SquadWorkflowSettings.tsx',
  'components/squads/WorkflowEditor.tsx',
  'components/squads/WorkspaceIndexingSettings.tsx',
  'components/squads/grants/CreateGrantForm.tsx',
  'components/squads/grants/GrantRiskBadge.tsx',
  'components/squads/grants/OutboundGrantsList.tsx',
  'components/workspace/FileUpload.tsx',
  'components/workspace/FileViewer.tsx',
  'components/workspace/TerminalTabs.tsx',
  'lib/agentTypeColor.ts',
  'lib/statusPresentation.ts',
  'lib/tool-renderers.tsx',
  'voice/VoiceCompanionWidget.tsx',
  'voice/VoiceTranscriptInspector.tsx',
]

const LEGACY_LITERAL_HEX_FILES: readonly string[] = [
  'components/ActionCenterContent.tsx',
  'components/ChatView.tsx',
  'components/MessageContent.tsx',
  'components/PullToRefresh.tsx',
  'components/TauLogo.tsx',
  'components/WorkStreamFileCard.tsx',
  'components/memory/MemoryFileViewer.tsx',
  'components/settings/SystemLogsSection.tsx',
  'components/squads/AgentVisualization.tsx',
  'components/squads/OrgGraph.tsx',
  'components/squads/SandboxLogs.tsx',
  'components/squads/SquadAgentThreads.css',
  'components/squads/SquadUniverse.tsx',
  'components/workspace/FileViewer.tsx',
  'components/workspace/Terminal.tsx',
  'components/workspace/TerminalTabs.tsx',
  'index.css',
  'lib/agentTypeColor.ts',
  'lib/statusPresentation.ts',
  'voice/VoiceTranscriptInspector.tsx',
]

const LEGACY_COLOR_FUNCTION_FILES: readonly string[] = [
  'components/VoiceWorkspacePage.tsx',
  'components/squads/AgentVisualization.tsx',
  'components/squads/OrgGraph.tsx',
  'components/squads/SquadUniverse.tsx',
  'design-system.css',
  'index.css',
]

const LEGACY_INLINE_COLOR_STYLE_FILES: readonly string[] = [
  'components/PullToRefresh.tsx',
  'components/squads/SquadUniverse.tsx',
]

/** Documented exception-policy annotations (report §4.3). */
const ENTRY_REASONS: Readonly<Record<string, string>> = {
  'components/TauLogo.tsx':
    'PD-5: temporary pending-tokenization via the planned --brand-* family (NOT a permanent exception)',
  'components/workspace/Terminal.tsx': 'temporary: planned terminal token family (phase 3)',
  'components/workspace/TerminalTabs.tsx': 'temporary: planned terminal token family (phase 3)',
  'components/artifacts/PresentationRenderer.tsx':
    'mixed: chart/presentation colors are content-authored (§4.3 permanent) alongside chrome palette use (phase 2+)',
  'index.css': 'temporary: ANSI palette (phase 3) and scrollbar thumb (phase 2); chrome tokens are channel-form now',
  'lib/statusPresentation.ts': 'temporary: status-role token family (phase 2)',
  'lib/agentTypeColor.ts': 'temporary: agent-type token family (phase 2); WCAG pair test stays authoritative',
  'components/PullToRefresh.tsx': 'temporary: brand purple pending --brand-* tokens (PD-5)',
  'components/VoiceWorkspacePage.tsx': 'temporary: voice orb CSS (phase 2+ sweep)',
  'components/squads/AgentVisualization.tsx': 'temporary: graph/canvas token bridge (phase 4)',
  'components/squads/SquadUniverse.tsx': 'temporary: graph/canvas token bridge (phase 4)',
  'components/squads/OrgGraph.tsx': 'temporary: graph/canvas token bridge (phase 4)',
  'design-system.css': 'one literal inset highlight; otherwise fully tokenized (phase 2)',
}

const ALLOWLIST: Readonly<Record<RawCategoryType, readonly string[]>> = {
  'palette-utility': LEGACY_PALETTE_UTILITY_FILES,
  'literal-hex': LEGACY_LITERAL_HEX_FILES,
  'color-function': LEGACY_COLOR_FUNCTION_FILES,
  'inline-color-style': LEGACY_INLINE_COLOR_STYLE_FILES,
}

describe('no-raw-colors guard', () => {
  test('every raw-color category in apps/web/src is allowlisted (no NEW violations)', () => {
    const files = [...new Bun.Glob('**/*.{ts,tsx,js,jsx,css}').scanSync({ cwd: srcRoot })]
      .filter((path) => !isTestArtifact(path))
      .sort()
    expect(files.length).toBeGreaterThan(500)

    const offenders: string[] = []
    const allowlistHits = new Set<string>()
    for (const path of files) {
      const findings = scanSourceForRawColors(path, readFileSync(join(srcRoot, path), 'utf8'))
      for (const finding of findings) {
        const allowed = ALLOWLIST[finding.category]!.includes(path)
        const key = `${finding.category}:${path}`
        if (allowed) {
          allowlistHits.add(key)
          continue
        }
        offenders.push(`${path}:${finding.line} [${finding.category}] ${finding.match}`)
      }
    }

    // Stale allowlist entries are failures too: they hide shrinkage and make
    // the ratchet meaningless. When a file is migrated, remove its entry.
    const stale: string[] = []
    for (const [category, paths] of Object.entries(ALLOWLIST)) {
      for (const path of paths) {
        if (!allowlistHits.has(`${category}:${path}`)) stale.push(`${category}: ${path}`)
      }
    }

    expect(
      `NEW raw colors (use theme tokens; see src/index.css + tailwind.config.js):\n${offenders.join('\n')}\nSTALE allowlist entries (migrated files must be removed from the allowlist):\n${stale.join('\n')}`
    ).toBe(
      `NEW raw colors (use theme tokens; see src/index.css + tailwind.config.js):\n\nSTALE allowlist entries (migrated files must be removed from the allowlist):\n`
    )
  })

  test('exception-policy annotations reference allowlisted files only', () => {
    const allowed = new Set(Object.values(ALLOWLIST).flatMap((paths) => [...paths]))
    const unknown = Object.keys(ENTRY_REASONS).filter((path) => !allowed.has(path))
    expect(unknown).toEqual([])
  })

  test('every allowlisted path exists on disk (the inventory tracks real files)', () => {
    const missing: string[] = []
    for (const paths of Object.values(ALLOWLIST)) {
      for (const path of paths) {
        if (!existsSync(join(srcRoot, path))) missing.push(path)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('raw-color detector', () => {
  test('flags Tailwind palette utilities, including under variant prefixes', () => {
    const source = '<div className="bg-gray-50 dark:text-blue-700 md:bg-red-500/30 border-slate-200" />'
    const findings = scanSourceForRawColors('synthetic.tsx', source)
    expect(findings.filter((f) => f.category === 'palette-utility').map((f) => f.match)).toEqual([
      'bg-gray-50',
      'dark:text-blue-700',
      'md:bg-red-500/30',
      'border-slate-200',
    ])
  })

  test('does not flag semantic token utilities or bare words', () => {
    const source = '<div className="bg-surface text-primary border-th-border divide-th-border/50 bg-page" />'
    expect(scanSourceForRawColors('synthetic.tsx', source)).toEqual([])
  })

  test('flags literal hex colors', () => {
    const findings = scanSourceForRawColors('synthetic.tsx', "const c = '#c4b5fd'; const d = '#ff000080';")
    expect(findings.map((f) => f.match)).toEqual(['#c4b5fd', '#ff000080'])
  })

  test('flags literal color functions but not token-wrapped or dynamic ones', () => {
    const source = [
      'a { background: rgb(var(--color-bg-surface)); }', // sanctioned channel wrapper
      'b { background: rgb(var(--color-bg-surface) / 0.5); }', // wrapper + alpha
      'c { background: color-mix(in srgb, rgb(var(--color-primary)) 10%, transparent); }', // token-only mix
      'd { background: rgba(156, 163, 175, 0.5); }', // literal
      'e { background: rgb(16 17 28); }', // literal channels
      'f { background: rgb(${channels}); }', // dynamic construction (runtime token read)
    ].join('\n')
    const findings = scanSourceForRawColors('synthetic.css', source).filter((f) => f.category === 'color-function')
    expect(findings.map((f) => f.line)).toEqual([4, 5])
  })

  test('flags color-bearing inline styles but not layout-only ones', () => {
    const colorBearing = '<span style={{ backgroundColor: node.color }} />'
    const layoutOnly = '<div style={{ height: 120, translateY: 4, maxWidth: `calc(${n}px)` }} />'
    expect(scanSourceForRawColors('synthetic.tsx', colorBearing).map((f) => f.category)).toEqual(['inline-color-style'])
    expect(scanSourceForRawColors('synthetic.tsx', layoutOnly)).toEqual([])
  })
})
