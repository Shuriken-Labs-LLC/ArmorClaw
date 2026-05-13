import { useEffect, useState } from 'react'
import type { DashboardSnapshot, GatewayConfig, OpenClawUpdateInfo } from '@/types/dashboard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog'
import {
  getAdvancedConfig,
  startGateway,
  restartGateway,
  runCommand,
  openConfig,
  backupConfig,
  getGatewayProbe,
  getOpenClawUpdate,
} from '@/lib/api'

interface Props {
  snapshot: DashboardSnapshot | null
}

function GatewayPanel({ gatewayReachable }: { gatewayReachable: boolean }) {
  const [probing, setProbing] = useState(false)
  const [reachable, setReachable] = useState(gatewayReachable)
  const [starting, setStarting] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    setReachable(gatewayReachable)
  }, [gatewayReachable])

  async function probe() {
    setProbing(true)
    try {
      const r = await getGatewayProbe()
      setReachable(r.reachable)
    } finally {
      setProbing(false)
    }
  }

  async function handleStart() {
    setStarting(true)
    setResult(null)
    try {
      const r = await startGateway()
      setResult(`Gateway started. PID: ${r.pid}`)
    } catch (e) {
      setResult(e instanceof Error ? e.message : 'Failed to start gateway')
    } finally {
      setStarting(false)
    }
  }

  async function handleRestart() {
    setRestarting(true)
    setResult(null)
    try {
      const r = await restartGateway()
      setResult(`Gateway restarted. PID: ${r.pid}`)
    } catch (e) {
      setResult(e instanceof Error ? e.message : 'Failed to restart gateway')
    } finally {
      setRestarting(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle>Gateway</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={reachable ? 'success' : 'rejected'}>
              {reachable ? 'Reachable' : 'Unreachable'}
            </Badge>
            <Button size="sm" variant="ghost" onClick={probe} disabled={probing}>
              {probing ? 'Probing…' : 'Probe'}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="secondary" onClick={handleStart} disabled={starting}>
            {starting ? 'Starting…' : 'Start gateway'}
          </Button>
          <Button size="sm" variant="outline" onClick={handleRestart} disabled={restarting}>
            {restarting ? 'Restarting…' : 'Restart'}
          </Button>
        </div>
        {result && <p className="text-xs text-ac-muted font-mono-code">{result}</p>}
      </CardContent>
    </Card>
  )
}

function UpdateNotice({ updateInfo }: { updateInfo: OpenClawUpdateInfo }) {
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  async function handleUpdate() {
    setConfirmOpen(false)
    setRunning(true)
    setOutput(null)
    try {
      const r = await runCommand('update')
      setOutput(r.output ?? r.message ?? 'Done')
    } catch (e) {
      setOutput(e instanceof Error ? e.message : 'Error')
    } finally {
      setRunning(false)
    }
  }

  if (!updateInfo.updateAvailable) {return null}

  return (
    <Alert variant="amber">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="font-medium text-sm">OpenClaw update available</p>
          <p className="text-xs mt-1 opacity-80">
            {updateInfo.currentVersion} → {updateInfo.latestVersion}
          </p>
          {output && (
            <pre className="font-mono-code text-xs mt-2 whitespace-pre-wrap break-all">{output}</pre>
          )}
        </div>
        <Button size="sm" variant="amber" onClick={() => setConfirmOpen(true)} disabled={running}>
          {running ? 'Updating…' : 'Update now'}
        </Button>
      </div>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update OpenClaw?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-ac-muted">
            This will run <code className="font-mono-code">openclaw update</code>. The agent will
            restart. Proceed?
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleUpdate}>Update</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Alert>
  )
}

function CommandRunner() {
  const [command, setCommand] = useState('')
  const [output, setOutput] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingCommand, setPendingCommand] = useState('')

  function handleSubmit() {
    if (!command.trim()) {return}
    setPendingCommand(command.trim())
    setConfirmOpen(true)
  }

  async function handleConfirm() {
    setConfirmOpen(false)
    setRunning(true)
    setOutput(null)
    try {
      const r = await runCommand(pendingCommand)
      setOutput(r.output ?? r.message ?? 'Done (no output)')
    } catch (e) {
      setOutput(`Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Command runner</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="status"
            className="font-mono-code text-sm flex-1"
            aria-label="OpenClaw command"
          />
          <Button onClick={handleSubmit} disabled={running || !command.trim()}>
            {running ? 'Running…' : 'Run'}
          </Button>
        </div>
        {output && (
          <pre className="font-mono-code text-xs text-ac-muted bg-ac-surface2 rounded-btn p-3 overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
            {output}
          </pre>
        )}
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run command?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-ac-muted">
            This will execute:{' '}
            <code className="font-mono-code text-ac-text">openclaw {pendingCommand}</code>
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleConfirm}>Run</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function ConfigViewer() {
  const [config, setConfig] = useState<GatewayConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState(false)

  useEffect(() => {
    setLoading(true)
    getAdvancedConfig()
      .then(setConfig)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function handleOpenInEditor() {
    setOpening(true)
    try {
      await openConfig()
    } finally {
      setOpening(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle>openclaw.json</CardTitle>
          <Button
            size="sm"
            variant="secondary"
            onClick={handleOpenInEditor}
            disabled={opening}
          >
            {opening ? 'Opening…' : 'Open in editor'}
          </Button>
        </div>
        {config?.path && (
          <p className="text-xs text-ac-muted font-mono-code">{config.path}</p>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-ac-muted">Loading…</p>
        ) : config ? (
          <pre className="font-mono-code text-xs text-ac-muted bg-ac-surface2 rounded-btn p-3 overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
            {JSON.stringify(config.config, null, 2)}
          </pre>
        ) : (
          <p className="text-sm text-ac-muted">Could not load config.</p>
        )}
      </CardContent>
    </Card>
  )
}

function BackupButton() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function handleBackup() {
    setLoading(true)
    setResult(null)
    try {
      const r = await backupConfig()
      setResult(`Backed up to: ${r.path}`)
    } catch (e) {
      setResult(e instanceof Error ? e.message : 'Backup failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" onClick={handleBackup} disabled={loading}>
        {loading ? 'Backing up…' : 'Backup config'}
      </Button>
      {result && <p className="text-xs text-ac-muted font-mono-code">{result}</p>}
    </div>
  )
}

function CanvasIframe({ reachable }: { reachable: boolean }) {
  const [iframeError, setIframeError] = useState(false)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>OpenClaw Canvas</CardTitle>
      </CardHeader>
      <CardContent className="p-0 relative" style={{ minHeight: 480 }}>
        {(!reachable || iframeError) && (
          <div className="absolute inset-0 flex items-center justify-center bg-ac-surface2 rounded-b-card z-10">
            <p className="text-sm text-ac-muted">Gateway offline — Canvas unavailable</p>
          </div>
        )}
        <iframe
          src="http://127.0.0.1:18789/__openclaw__/canvas/"
          className="w-full rounded-b-card"
          style={{ height: 480, border: 'none', display: 'block' }}
          title="OpenClaw Canvas"
          onError={() => setIframeError(true)}
        />
      </CardContent>
    </Card>
  )
}

export function AdvancedView({ snapshot }: Props) {
  const [updateInfo, setUpdateInfo] = useState<OpenClawUpdateInfo | null>(null)

  useEffect(() => {
    getOpenClawUpdate()
      .then(setUpdateInfo)
      .catch(() => {})
  }, [])

  const reachable = snapshot?.gatewayReachable ?? false

  return (
    <div className="flex flex-col gap-4">
      {/* Amber warning banner — always visible */}
      <Alert variant="amber">
        <AlertDescription>
          Changes here affect the underlying OpenClaw runtime directly. Proceed with care.
        </AlertDescription>
      </Alert>

      {/* Update notice */}
      {updateInfo && <UpdateNotice updateInfo={updateInfo} />}

      {/* Gateway */}
      <GatewayPanel gatewayReachable={reachable} />

      {/* OpenClaw Canvas iframe */}
      <CanvasIframe reachable={reachable} />

      {/* Command runner */}
      <CommandRunner />

      {/* Config viewer */}
      <ConfigViewer />

      {/* Backup */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Backup</CardTitle>
        </CardHeader>
        <CardContent>
          <BackupButton />
        </CardContent>
      </Card>
    </div>
  )
}
