import { useEffect, useState } from 'react'
import type { DashboardSnapshot, ChannelInfo, OllamaStatus } from '@/types/dashboard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog'
import {
  setProvider,
  getOllamaStatus,
  setSandbox,
  getLaunchOnStartup,
  setLaunchOnStartup,
  getChannels,
  validateTelegramToken,
  saveTelegramConfig,
  setBudget,
  getMemory,
  clearMemory,
  openMemory,
  getVectorStatus,
  reindexMemory,
  auditExportUrl,
  resetData,
} from '@/lib/api'
import { formatCost } from '@/lib/utils'

interface Props {
  snapshot: DashboardSnapshot | null
}

type Provider = 'anthropic' | 'openai' | 'ollama'

function ModelProviderSection({ config }: { config: DashboardSnapshot['config'] }) {
  const [provider, setProviderState] = useState<Provider>(
    (config.activeProvider as Provider | null) ?? 'anthropic',
  )
  const [apiKey, setApiKey] = useState('')
  const [ollamaUrl, setOllamaUrl] = useState('')
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    getOllamaStatus()
      .then(setOllamaStatus)
      .catch(() => {})
  }, [])

  async function handleSave() {
    setError(null)
    setSaving(true)
    try {
      await setProvider({
        provider,
        apiKey: provider === 'ollama' ? ollamaUrl : apiKey,
      })
      setSuccess(true)
      setTimeout(() => setSuccess(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const providerOptions: { value: Provider; label: string }[] = [
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'ollama', label: 'Ollama (local)' },
  ]

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Model provider</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex gap-2 flex-wrap">
          {providerOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setProviderState(opt.value)}
              className={`px-4 py-2 rounded-btn text-sm transition-colors min-h-[44px] border ${
                provider === opt.value
                  ? 'bg-ac-teal-light border-ac-teal text-ac-teal'
                  : 'border-ac-border text-ac-muted hover:text-ac-text hover:bg-ac-surface2'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {provider !== 'ollama' ? (
          <div>
            <Label htmlFor="api-key" className="mb-1.5 block">
              API Key
            </Label>
            <Input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="••••••••••••••••"
              className="font-mono-code"
              aria-label={`${provider} API key`}
            />
            <p className="text-xs text-ac-hint mt-1">
              {provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}
            </p>
          </div>
        ) : (
          <div>
            <Label htmlFor="ollama-url" className="mb-1.5 block">
              Ollama base URL
            </Label>
            <Input
              id="ollama-url"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              placeholder="http://localhost:11434"
              className="font-mono-code"
            />
            {ollamaStatus && (
              <div className="mt-2 flex items-center gap-2">
                <Badge variant={ollamaStatus.reachable ? 'success' : 'rejected'}>
                  {ollamaStatus.reachable ? 'Reachable' : 'Unreachable'}
                </Badge>
                {ollamaStatus.models.length > 0 && (
                  <span className="text-xs text-ac-muted">
                    {ollamaStatus.models.join(', ')}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : success ? 'Saved' : 'Save provider'}
          </Button>
          {error && <p className="text-xs text-ac-red">{error}</p>}
        </div>
      </CardContent>
    </Card>
  )
}

function SandboxSection({ sandboxDir }: { sandboxDir: string | null }) {
  const [path, setPath] = useState(sandboxDir ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (!path.trim()) return
    setError(null)
    setSaving(true)
    try {
      await setSandbox(path.trim())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Sandbox directory</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-ac-muted">
          The agent can only read/write files within this directory. Use an absolute path.
        </p>
        <div className="flex gap-2">
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/you/Documents/ArmorClaw"
            className="font-mono-code text-sm flex-1"
          />
          <Button onClick={handleSave} disabled={saving || !path.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {error && <p className="text-xs text-ac-red">{error}</p>}
      </CardContent>
    </Card>
  )
}

function EmailSection({ connectedServices }: { connectedServices: DashboardSnapshot['connectedServices'] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Email (Gmail)</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Badge variant={connectedServices.gmail ? 'success' : 'muted'}>
            {connectedServices.gmail ? 'Connected' : 'Not connected'}
          </Badge>
          {connectedServices.outlook && (
            <Badge variant="success">Outlook</Badge>
          )}
        </div>
        {!connectedServices.gmail && (
          <p className="text-sm text-ac-muted">
            To connect Gmail, use the onboarding wizard (Step 3). App-password / IMAP only.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function ChannelsSection() {
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [telegramToken, setTelegramToken] = useState('')
  const [telegramUsername, setTelegramUsername] = useState('')
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [validationResult, setValidationResult] = useState<{
    ok: boolean
    username?: string
    error?: string
  } | null>(null)

  useEffect(() => {
    getChannels()
      .then((r) => setChannels(r.channels))
      .catch(() => {})
  }, [])

  async function handleValidate() {
    if (!telegramToken.trim()) return
    setValidating(true)
    setValidationResult(null)
    try {
      const r = await validateTelegramToken(telegramToken.trim())
      setValidationResult(r)
      if (r.ok && r.username) setTelegramUsername(r.username)
    } finally {
      setValidating(false)
    }
  }

  async function handleSave() {
    if (!telegramToken.trim() || !telegramUsername.trim()) return
    setSaving(true)
    try {
      await saveTelegramConfig(telegramToken.trim(), telegramUsername.trim())
      getChannels()
        .then((r) => setChannels(r.channels))
        .catch(() => {})
    } finally {
      setSaving(false)
    }
  }

  const telegramChannel = channels.find((c) => c.id === 'telegram')

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Channels</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Telegram */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ac-text">Telegram</span>
            {telegramChannel && (
              <Badge
                variant={
                  telegramChannel.status === 'active'
                    ? 'success'
                    : telegramChannel.status === 'error'
                    ? 'rejected'
                    : 'muted'
                }
              >
                {telegramChannel.status}
              </Badge>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              type="password"
              value={telegramToken}
              onChange={(e) => setTelegramToken(e.target.value)}
              placeholder="Bot token"
              className="font-mono-code text-sm flex-1"
              aria-label="Telegram bot token"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={handleValidate}
              disabled={validating || !telegramToken.trim()}
            >
              {validating ? 'Validating…' : 'Validate'}
            </Button>
          </div>
          {validationResult && (
            <p className={`text-xs ${validationResult.ok ? 'text-ac-teal' : 'text-ac-red'}`}>
              {validationResult.ok
                ? `Valid — @${validationResult.username}`
                : validationResult.error}
            </p>
          )}
          {validationResult?.ok && (
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save Telegram config'}
            </Button>
          )}
        </div>

        {/* Other channels */}
        {channels
          .filter((c) => c.id !== 'telegram')
          .map((c) => (
            <div key={c.id} className="flex items-center justify-between py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm">{c.icon}</span>
                <span className="text-sm text-ac-text">{c.name}</span>
              </div>
              <Badge
                variant={
                  c.status === 'active'
                    ? 'success'
                    : c.status === 'error'
                    ? 'rejected'
                    : 'muted'
                }
              >
                {c.status}
              </Badge>
            </div>
          ))}
      </CardContent>
    </Card>
  )
}

function BudgetSection({ current }: { current: number }) {
  const [value, setValue] = useState(String(current))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    const num = parseFloat(value)
    if (isNaN(num) || num <= 0) {
      setError('Enter a positive number')
      return
    }
    setError(null)
    setSaving(true)
    try {
      await setBudget(num)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Monthly budget</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-ac-muted">
          Current: {formatCost(current)} / month. Agent calls stop when this is exceeded.
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ac-muted text-sm">
              $
            </span>
            <Input
              type="number"
              min="1"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="pl-7"
              aria-label="Monthly budget"
            />
          </div>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {error && <p className="text-xs text-ac-red">{error}</p>}
      </CardContent>
    </Card>
  )
}

function StartupSection() {
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    getLaunchOnStartup()
      .then((r) => {
        setEnabled(r.enabled)
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [])

  async function handleToggle(checked: boolean) {
    try {
      const r = await setLaunchOnStartup(checked)
      setEnabled(r.enabled)
    } catch {
      // revert on failure
    }
  }

  if (!loaded) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Launch on startup</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <p className="text-sm text-ac-muted">Start ArmorClaw automatically when you log in.</p>
          <Switch
            checked={enabled}
            onCheckedChange={handleToggle}
            aria-label="Launch on startup"
          />
        </div>
      </CardContent>
    </Card>
  )
}

function TailscaleSection({ url }: { url: string | null }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Tailscale</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {url ? (
          <p className="text-sm text-ac-teal font-mono-code break-all">{url}</p>
        ) : (
          <p className="text-sm text-ac-muted">No Tailscale URL detected.</p>
        )}
        <p className="text-xs text-ac-hint">
          Enable Tailscale Serve to access the dashboard remotely.
        </p>
      </CardContent>
    </Card>
  )
}

function MemorySection() {
  const [content, setContent] = useState<string | null>(null)
  const [vectorStatus, setVectorStatus] = useState<string | null>(null)
  const [vectorAvailable, setVectorAvailable] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  const [reindexOutput, setReindexOutput] = useState<string | null>(null)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)

  useEffect(() => {
    getMemory()
      .then((r) => setContent(r.content))
      .catch(() => {})
    getVectorStatus()
      .then((r) => {
        setVectorStatus(r.status)
        setVectorAvailable(r.available)
      })
      .catch(() => {})
  }, [])

  async function handleClear() {
    setClearDialogOpen(false)
    try {
      await clearMemory()
      setContent('')
    } catch {
      // ignore
    }
  }

  async function handleReindex() {
    setReindexing(true)
    setReindexOutput(null)
    try {
      const r = await reindexMemory()
      setReindexOutput(r.output)
    } catch (e) {
      setReindexOutput(e instanceof Error ? e.message : 'Error')
    } finally {
      setReindexing(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Memory</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Textarea
          readOnly
          value={content ?? 'Loading…'}
          className="font-mono-code text-xs h-40 text-ac-muted"
          aria-label="Memory file contents"
        />
        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => openMemory().catch(() => {})}
          >
            Open in editor
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-ac-red border-ac-red/30 hover:bg-ac-red-light"
            onClick={() => setClearDialogOpen(true)}
          >
            Clear memory
          </Button>
        </div>

        {/* Vector index */}
        <div className="flex items-center justify-between pt-2 border-t border-ac-border">
          <div>
            <p className="text-sm text-ac-text">Vector index</p>
            {vectorStatus && (
              <p className="text-xs text-ac-muted">{vectorStatus}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={vectorAvailable ? 'success' : 'muted'}>
              {vectorAvailable ? 'Available' : 'Unavailable'}
            </Badge>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleReindex}
              disabled={reindexing}
            >
              {reindexing ? 'Reindexing…' : 'Re-index'}
            </Button>
          </div>
        </div>
        {reindexOutput && (
          <pre className="font-mono-code text-xs text-ac-muted bg-ac-surface2 rounded-btn p-2 max-h-32 overflow-auto">
            {reindexOutput}
          </pre>
        )}
      </CardContent>

      <Dialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear memory?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-ac-muted">
            This will reset memory.md to a blank header. This cannot be undone.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleClear}>
              Clear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function AuditExportSection() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Audit log export</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-ac-muted mb-3">
          Download all audit log entries as a CSV file.
        </p>
        <Button
          variant="secondary"
          onClick={() => {
            window.location.href = auditExportUrl()
          }}
        >
          Download CSV
        </Button>
      </CardContent>
    </Card>
  )
}

function SubscriptionSection({
  license,
  stripeUrl,
}: {
  license: DashboardSnapshot['license']
  stripeUrl: string
}) {
  if (!stripeUrl) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Subscription</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {license.tier === 'trial' && (
          <div className="rounded-btn bg-ac-purple-light border border-ac-purple/30 px-3 py-2 text-sm text-ac-purple">
            You're on a trial. Upgrade to keep access after the trial ends.
          </div>
        )}
        <div className="flex items-center gap-2">
          <Badge variant={license.valid ? 'success' : 'rejected'}>
            {license.tier}
          </Badge>
        </div>
        <Button
          variant="secondary"
          onClick={() => window.open(stripeUrl, '_blank')}
        >
          Manage subscription
        </Button>
      </CardContent>
    </Card>
  )
}

function DangerZone() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [resetting, setResetting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function handleReset() {
    if (confirmText !== 'reset') return
    setResetting(true)
    try {
      const r = await resetData()
      setResult(`Deleted ${r.deleted} file(s). Audit log and token history cleared.`)
      setDialogOpen(false)
    } catch (e) {
      setResult(e instanceof Error ? e.message : 'Reset failed')
    } finally {
      setResetting(false)
      setConfirmText('')
    }
  }

  return (
    <Card className="border-ac-red/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-ac-red">Danger zone</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-ac-muted">
          Delete the audit log and token history. This cannot be undone.
        </p>
        <Button
          variant="destructive"
          onClick={() => setDialogOpen(true)}
          className="w-fit"
        >
          Reset ArmorClaw data
        </Button>
        {result && <p className="text-xs text-ac-muted">{result}</p>}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-ac-red">Reset ArmorClaw data?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-ac-muted">
            This will permanently delete your audit log and token history. Type{' '}
            <span className="font-mono-code text-ac-text">reset</span> to confirm.
          </p>
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="reset"
            className="font-mono-code"
            aria-label="Confirm reset"
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={handleReset}
              disabled={confirmText !== 'reset' || resetting}
            >
              {resetting ? 'Resetting…' : 'Reset'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export function SettingsView({ snapshot }: Props) {
  if (!snapshot) {
    return (
      <div className="flex items-center justify-center h-64 text-ac-muted">
        Connecting…
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-medium text-ac-text">Settings</h1>

      <ModelProviderSection config={snapshot.config} />
      <SandboxSection sandboxDir={snapshot.config.sandboxDir} />
      <EmailSection connectedServices={snapshot.connectedServices} />
      <ChannelsSection />
      <BudgetSection current={snapshot.budget.monthlyBudgetUSD} />
      <StartupSection />
      <TailscaleSection url={snapshot.tailscaleUrl} />
      <MemorySection />
      <AuditExportSection />
      <SubscriptionSection
        license={snapshot.license}
        stripeUrl={snapshot.stripeCustomerPortalUrl}
      />
      <DangerZone />
    </div>
  )
}
