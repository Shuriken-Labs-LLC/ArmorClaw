export interface AuditEntry {
  timestamp: string
  skill: string
  outcome: 'success' | 'rejected' | 'error' | 'undone'
  durationMs: number
  permissionsUsed: string[]
  inputSummary?: string
  seq?: number
  prevHash?: string
  hmac?: string | null
}

export interface TokenEvent {
  timestamp: string
  provider: 'anthropic' | 'openai' | 'ollama'
  model: string
  skill: string
  inputTokens: number
  outputTokens: number
  estimatedCostUSD: number
}

export interface SkillInfo {
  skillId: string
  displayName: string
  description: string
  version: string
  author: 'bundled'
  permissionManifest: string[]
  undoable: boolean
  recipeEligible: boolean
  digestMention: boolean
}

export interface RecipeWithState {
  id: string
  name: string
  description: string
  skill: string
  defaultSchedule: string
  scheduleLabel: string
  undoable: boolean
  active: boolean
  currentSchedule: string
}

export interface DashboardSnapshot {
  agentStatus: 'running' | 'paused' | 'error'
  gatewayReachable: boolean

  config: {
    modelProvider: string | null
    isLocal: boolean
    activeProvider: string | null
    ollamaReachable: boolean
    ollamaModels: string[]
    sandboxDir: string | null
  }

  channels: Array<{
    name: string
    url: string
    icon: string
  }>

  budget: {
    monthlyBudgetUSD: number
    spentThisMonthUSD: number
    percentUsed: number
    hardStopActive: boolean
    atWarning: boolean
  }

  monthTokens: {
    inputTokens: number
    outputTokens: number
    estimatedCostUSD: number
  }

  undo: {
    id: string
    actionType: 'email-draft' | 'file-write'
    skill: string
    expiresAt: string
  } | null

  pendingApprovals: Array<{
    id: string
    skill: string
    displayName: string
    requestedAt: string
    source: 'local' | 'gateway'
    toolParams: Record<string, unknown>
  }>

  feed: AuditEntry[]

  skills: SkillInfo[]

  recipes: RecipeWithState[]

  connectedServices: {
    gmail: boolean
    outlook: boolean
  }

  tailscaleUrl: string | null

  stripeCustomerPortalUrl: string
  paymentLinkBase: string

  license: {
    tier: string
    installId: string
    valid: boolean
  }

  security: {
    injectionFilterActive: boolean
    rejectionsToday: number
    sparkline7d: number[]
    gatewayHost: string
  }

  tokenBurn: {
    todayTokens: {
      inputTokens: number
      outputTokens: number
      estimatedCostUSD: number
    }
    monthBySkill: Record<string, number>
    dailyHistory30: Array<{
      date: string
      inputTokens: number
      outputTokens: number
      estimatedCostUSD: number
    }>
    recentEvents: TokenEvent[]
  }

  serverTime: string
}

export interface BundledSkillStatus {
  id: string
  displayName: string
  description: string
  version: string
  status: 'active' | 'not_configured'
  missingConfig?: string
}

export interface ChannelInfo {
  id: string
  name: string
  description: string
  icon: string
  status: 'active' | 'not_configured' | 'error'
  configurable: boolean
}

export interface OllamaStatus {
  reachable: boolean
  models: string[]
  isActive: boolean
  isLocal: boolean
}

export interface GatewayConfig {
  ok: true
  config: Record<string, unknown>
  path: string
}

export interface OpenClawUpdateInfo {
  ok: true
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
}

export interface MemoryInfo {
  ok: true
  content: string
  path: string
}

export interface VectorStatus {
  ok: true
  available: boolean
  status: string
}
