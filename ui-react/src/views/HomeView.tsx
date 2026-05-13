import { useEffect, useState } from 'react'
import type { DashboardSnapshot } from '@/types/dashboard'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import {
  pauseAgent,
  resumeAgent,
  triggerUndo,
  approveRequest,
  rejectRequest,
  resumeBudgetHardStop,
} from '@/lib/api'
import { formatRelativeTime, formatCountdown, formatCost } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { Link } from 'react-router-dom'

interface Props {
  snapshot: DashboardSnapshot | null
}

function AgentStatusPill({ status }: { status: DashboardSnapshot['agentStatus'] }) {
  const map = {
    running: { label: 'Running', cls: 'bg-ac-teal-light text-ac-teal' },
    paused: { label: 'Paused', cls: 'bg-ac-amber-light text-ac-amber' },
    error: { label: 'Error', cls: 'bg-ac-red-light text-ac-red' },
  }
  const { label, cls } = map[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-3 py-1 rounded-badge text-sm font-medium', cls)}>
      <span className="w-2 h-2 rounded-full bg-current opacity-80" />
      {label}
    </span>
  )
}

function UndoBanner({ undo }: { undo: NonNullable<DashboardSnapshot['undo']> }) {
  const [seconds, setSeconds] = useState(formatCountdown(undo.expiresAt))
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (seconds <= 0) return
    const id = setInterval(() => {
      const s = formatCountdown(undo.expiresAt)
      setSeconds(s)
      if (s <= 0) clearInterval(id)
    }, 1000)
    return () => clearInterval(id)
  }, [undo.expiresAt, seconds])

  if (dismissed || seconds <= 0) return null

  const label =
    undo.actionType === 'email-draft'
      ? 'Email draft staged for approval'
      : `File written by ${undo.skill}`

  async function handleUndo() {
    await triggerUndo()
    setDismissed(true)
  }

  return (
    <div className="flex items-center justify-between rounded-card bg-ac-surface2 border border-ac-border px-4 py-3 gap-3">
      <span className="text-sm text-ac-text flex-1 min-w-0 truncate">
        {label}
      </span>
      <div className="flex items-center gap-2 shrink-0">
        <Button size="sm" variant="secondary" onClick={handleUndo}>
          Undo ({seconds}s)
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}

function ApprovalCard({ approvals }: { approvals: DashboardSnapshot['pendingApprovals'] }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)

  if (approvals.length === 0) return null

  async function handle(id: string, action: 'approve' | 'reject') {
    setLoading(id)
    try {
      if (action === 'approve') await approveRequest(id)
      else await rejectRequest(id)
    } finally {
      setLoading(null)
    }
  }

  return (
    <div
      className="rounded-card bg-ac-blue-light p-4 flex flex-col gap-3"
      style={{ border: '0.5px solid #2A2D3A', borderLeft: '4px solid #82AAFF' }}
    >
      <p className="text-sm font-medium text-ac-blue">
        {approvals.length} pending approval{approvals.length > 1 ? 's' : ''}
      </p>
      {approvals.map((a) => (
        <div key={a.id} className="bg-ac-surface rounded-btn p-3 flex flex-col gap-2">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div>
              <p className="text-sm font-medium text-ac-text">{a.displayName}</p>
              <p className="text-xs text-ac-muted">{formatRelativeTime(a.requestedAt)}</p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => handle(a.id, 'approve')}
                disabled={loading === a.id}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handle(a.id, 'reject')}
                disabled={loading === a.id}
              >
                Reject
              </Button>
            </div>
          </div>
          <button
            className="text-xs text-ac-muted hover:text-ac-text text-left"
            onClick={() => setExpanded(expanded === a.id ? null : a.id)}
          >
            {expanded === a.id ? '▲ Hide params' : '▼ Show params'}
          </button>
          {expanded === a.id && (
            <pre className="font-mono-code text-xs text-ac-muted bg-ac-surface2 rounded p-2 overflow-x-auto max-h-40">
              {JSON.stringify(a.toolParams, null, 2)}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}

function TokenWidget({ budget }: { budget: DashboardSnapshot['budget'] }) {
  const { spentThisMonthUSD, monthlyBudgetUSD, percentUsed, hardStopActive, atWarning } = budget
  const barColor =
    percentUsed >= 100 ? 'bg-ac-red' : atWarning ? 'bg-ac-amber' : 'bg-ac-teal'
  const capped = Math.min(percentUsed, 100)

  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        {hardStopActive && (
          <div className="mb-3 flex items-center justify-between rounded-btn bg-ac-red-light px-3 py-2 gap-2">
            <p className="text-sm text-ac-red">Spending limit reached — agent is paused.</p>
            <Button size="sm" variant="destructive" onClick={() => resumeBudgetHardStop()}>
              Resume
            </Button>
          </div>
        )}
        <p className="text-sm text-ac-text mb-2">
          You've spent{' '}
          <span className="font-medium">{formatCost(spentThisMonthUSD)}</span> of your{' '}
          <span className="font-medium">{formatCost(monthlyBudgetUSD)}</span> budget.
        </p>
        <Progress value={capped} indicatorClassName={barColor} className="h-1.5" />
        <div className="mt-2 text-right">
          <Link to="/token-burn" className="text-xs text-ac-teal hover:underline">
            See breakdown →
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}

function ActivityFeed({ feed }: { feed: DashboardSnapshot['feed'] }) {
  const borderColor = {
    success: '#1DE9B6',
    rejected: '#FF5370',
    error: '#FF5370',
    undone: '#FFB347',
  }
  const bgColor = {
    success: '',
    rejected: 'bg-ac-red-light/40',
    error: 'bg-ac-red-light/40',
    undone: 'bg-ac-amber-light/40',
  }

  if (feed.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 pb-6 text-center text-sm text-ac-muted">
          No activity yet.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="pt-0 pb-0 divide-y divide-ac-border">
        {feed.map((entry, i) => (
          <div
            key={i}
            className={cn('flex items-center gap-3 py-3 px-4', bgColor[entry.outcome])}
            style={{ borderLeft: `4px solid ${borderColor[entry.outcome]}` }}
          >
            <span className="text-xs text-ac-muted shrink-0 w-16">
              {formatRelativeTime(entry.timestamp)}
            </span>
            <span className="text-sm text-ac-text flex-1 min-w-0 truncate">
              {entry.skill}
            </span>
            <Badge
              variant={
                entry.outcome === 'success'
                  ? 'success'
                  : entry.outcome === 'undone'
                  ? 'undone'
                  : 'rejected'
              }
            >
              {entry.outcome}
            </Badge>
            <span className="text-xs text-ac-muted shrink-0">{entry.durationMs}ms</span>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function RecipeShortcutRow({ recipes }: { recipes: DashboardSnapshot['recipes'] }) {
  const active = recipes.filter((r) => r.active).slice(0, 3)
  if (active.length === 0) return null

  return (
    <div className="flex gap-3 flex-wrap">
      {active.map((r) => (
        <div
          key={r.id}
          className="flex items-center gap-2 rounded-card bg-ac-surface px-4 py-3 flex-1 min-w-[150px]"
          style={{ border: '0.5px solid #2A2D3A' }}
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-ac-text truncate">{r.name}</p>
            <p className="text-xs text-ac-muted">{r.scheduleLabel}</p>
          </div>
          <span className="w-2 h-2 rounded-full bg-ac-teal shrink-0" />
        </div>
      ))}
    </div>
  )
}

export function HomeView({ snapshot }: Props) {
  const [agentLoading, setAgentLoading] = useState(false)

  if (!snapshot) {
    return (
      <div className="flex items-center justify-center h-64 text-ac-muted">
        Connecting…
      </div>
    )
  }

  async function toggleAgent() {
    if (!snapshot) return
    setAgentLoading(true)
    try {
      if (snapshot.agentStatus === 'running') await pauseAgent()
      else await resumeAgent()
    } finally {
      setAgentLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Agent status */}
      <div className="flex items-center gap-4 flex-wrap">
        <AgentStatusPill status={snapshot.agentStatus} />
        <div className="flex items-center gap-1.5 text-xs text-ac-muted">
          <span
            className={cn(
              'w-2 h-2 rounded-full',
              snapshot.gatewayReachable ? 'bg-ac-teal' : 'bg-ac-red',
            )}
          />
          Gateway {snapshot.gatewayReachable ? 'reachable' : 'unreachable'}
        </div>
        <Button
          size="sm"
          variant={snapshot.agentStatus === 'running' ? 'outline' : 'default'}
          onClick={toggleAgent}
          disabled={agentLoading}
          className="ml-auto"
        >
          {snapshot.agentStatus === 'running' ? 'Pause agent' : 'Resume agent'}
        </Button>
      </div>

      {/* Undo banner */}
      {snapshot.undo && <UndoBanner undo={snapshot.undo} />}

      {/* Pending approvals */}
      <ApprovalCard approvals={snapshot.pendingApprovals} />

      {/* Token burn widget */}
      <TokenWidget budget={snapshot.budget} />

      {/* Activity feed */}
      <div>
        <h2 className="text-xs font-medium text-ac-muted uppercase tracking-wide mb-2">
          Recent activity
        </h2>
        <ActivityFeed feed={snapshot.feed} />
      </div>

      {/* Recipes shortcut */}
      {snapshot.recipes.some((r) => r.active) && (
        <div>
          <h2 className="text-xs font-medium text-ac-muted uppercase tracking-wide mb-2">
            Active recipes
          </h2>
          <RecipeShortcutRow recipes={snapshot.recipes} />
        </div>
      )}
    </div>
  )
}
