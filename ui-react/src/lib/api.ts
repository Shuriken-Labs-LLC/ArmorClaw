import type {
  DashboardSnapshot,
  BundledSkillStatus,
  ChannelInfo,
  OllamaStatus,
  GatewayConfig,
  OpenClawUpdateInfo,
  MemoryInfo,
  VectorStatus,
} from '@/types/dashboard'

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`POST ${path} failed (${res.status}): ${text}`)
  }
  return res.json() as Promise<T>
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GET ${path} failed (${res.status}): ${text}`)
  }
  return res.json() as Promise<T>
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`DELETE ${path} failed (${res.status}): ${text}`)
  }
  return res.json() as Promise<T>
}

// §2.2 — One-shot snapshot
export const getDashboard = () => get<DashboardSnapshot>('/api/dashboard')

// §2.3 — Agent control
export const pauseAgent = () => post<{ ok: true }>('/api/agent/pause')
export const resumeAgent = () => post<{ ok: true }>('/api/agent/resume')

// §2.4 — Approvals
export const approveRequest = (id: string) =>
  post<{ ok: boolean }>(`/api/approvals/${id}/approve`)
export const rejectRequest = (id: string) =>
  post<{ ok: boolean }>(`/api/approvals/${id}/reject`)

// §2.5 — Undo
export const triggerUndo = () => post<{ ok: boolean }>('/api/undo')

// §2.6 — Budget
export const setBudget = (monthlyBudgetUSD: number) =>
  post<{ ok: boolean; message?: string }>('/api/budget', { monthlyBudgetUSD })
export const resumeBudgetHardStop = () => post<{ ok: true }>('/api/budget/resume')

// §2.7 — Token recording
export const recordTokens = (params: {
  provider?: string
  model?: string
  skill?: string
  inputTokens?: number
  outputTokens?: number
}) => post<{ ok: true; recorded: boolean; estimatedCostUSD: number }>('/api/tokens/record', params)

// §2.8 — Settings: model provider
export const setProvider = (params: {
  provider: 'anthropic' | 'openai' | 'ollama'
  apiKey?: string
}) => post<{ ok: true }>('/api/settings/provider', params)
export const getOllamaStatus = () => get<OllamaStatus>('/api/settings/ollama-status')

// §2.9 — Settings: sandbox
export const setSandbox = (path: string) =>
  post<{ ok: true }>('/api/settings/sandbox', { path })

// §2.10 — Settings: launch on startup
export const getLaunchOnStartup = () => get<{ enabled: boolean }>('/api/settings/launch-on-startup')
export const setLaunchOnStartup = (enabled: boolean) =>
  post<{ ok: true; enabled: boolean }>('/api/settings/launch-on-startup', { enabled })

// §2.11 — Security: browser allowlist
export const getBrowserAllowlist = () =>
  get<{ domains: string[] }>('/api/security/browser-allowlist')
export const addBrowserAllowlistDomain = (domain: string) =>
  post<{ ok: true; domains: string[] }>('/api/security/browser-allowlist/add', { domain })
export const removeBrowserAllowlistDomain = (domain: string) =>
  del<{ ok: true; domains: string[] }>(`/api/security/browser-allowlist/${encodeURIComponent(domain)}`)

// §2.12 — Memory
export const getMemory = () => get<MemoryInfo>('/api/memory')
export const clearMemory = () => post<{ ok: true }>('/api/memory/clear')
export const openMemory = () => post<{ ok: true }>('/api/memory/open')
export const getVectorStatus = () => get<VectorStatus>('/api/memory/vector-status')
export const reindexMemory = () => post<{ ok: true; output: string }>('/api/memory/reindex')

// §2.13 — Audit export (returns a download URL — caller navigates to it)
export const auditExportUrl = () => `${BASE}/api/audit/export.csv`

// §2.14 — Skills
export const getBundledSkills = () => get<BundledSkillStatus[]>('/api/skills/bundled')

// §2.15 — Recipes
export const activateRecipe = (id: string) =>
  post<{ ok: true }>(`/api/recipes/${id}/activate`)
export const deactivateRecipe = (id: string) =>
  post<{ ok: true }>(`/api/recipes/${id}/deactivate`)
export const setRecipeSchedule = (id: string, cron: string) =>
  post<{ ok: true }>(`/api/recipes/${id}/schedule`, { cron })

// §2.16 — Channels
export const getChannels = () =>
  get<{ ok: true; channels: ChannelInfo[] }>('/api/channels')
export const validateTelegramToken = (token: string) =>
  post<{ ok: boolean; username?: string; error?: string }>(
    '/api/channels/telegram/validate',
    { token },
  )
export const saveTelegramConfig = (token: string, username: string) =>
  post<{ ok: true }>('/api/channels/telegram/save', { token, username })
export const restartGateway = () =>
  post<{ ok: true; pid: number }>('/api/channels/gateway/restart')

// §2.17 — Advanced
export const getAdvancedConfig = () => get<GatewayConfig>('/api/advanced/config')
export const startGateway = () => post<{ ok: true; pid: number }>('/api/advanced/start-gateway')
export const runCommand = (command: string) =>
  post<{ ok: boolean; output?: string; message?: string }>('/api/advanced/run-command', { command })
export const openConfig = () => post<{ ok: true }>('/api/advanced/open-config')
export const backupConfig = () => post<{ ok: true; path: string }>('/api/advanced/backup-config')
export const getGatewayProbe = () => get<{ ok: true; reachable: boolean }>('/api/advanced/gateway-probe')
export const getOpenClawUpdate = () => get<OpenClawUpdateInfo>('/api/advanced/openclaw-update')

// §2.18 — Chat gateway config
export const getGatewayConfig = () =>
  get<{ wsUrl: string; token: string; error?: string }>('/api/chat/gateway-config')

// §2.19 — Danger zone
export const resetData = () =>
  post<{ ok: true; deleted: number }>('/api/reset', { confirm: 'reset' })
