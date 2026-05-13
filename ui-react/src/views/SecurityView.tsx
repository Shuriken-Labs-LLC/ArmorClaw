import { useEffect, useState } from 'react'
import type { DashboardSnapshot } from '@/types/dashboard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  getBrowserAllowlist,
  addBrowserAllowlistDomain,
  removeBrowserAllowlistDomain,
} from '@/lib/api'
import { formatRelativeTime } from '@/lib/utils'

interface Props {
  snapshot: DashboardSnapshot | null
}

function StatusBadge({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between py-2.5 px-4 rounded-btn bg-ac-surface2">
      <span className="text-sm text-ac-text">{label}</span>
      <Badge variant="success">Active</Badge>
    </div>
  )
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1)
  return (
    <div className="flex items-end gap-1 h-8" aria-hidden>
      {values.map((v, i) => {
        const pct = (v / max) * 100
        return (
          <div
            key={i}
            className="flex-1 rounded-sm bg-ac-red/60"
            style={{ height: `${Math.max(pct, 4)}%` }}
            title={String(v)}
          />
        )
      })}
    </div>
  )
}

function BrowserAllowlist() {
  const [domains, setDomains] = useState<string[]>([])
  const [newDomain, setNewDomain] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    getBrowserAllowlist()
      .then((r) => setDomains(r.domains))
      .catch(() => {})
  }, [])

  async function handleAdd() {
    if (!newDomain.trim()) {return}
    setAddError(null)
    setAdding(true)
    try {
      const result = await addBrowserAllowlistDomain(newDomain.trim())
      setDomains(result.domains)
      setNewDomain('')
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Failed to add domain')
    } finally {
      setAdding(false)
    }
  }

  async function handleRemove(domain: string) {
    try {
      const result = await removeBrowserAllowlistDomain(domain)
      setDomains(result.domains)
    } catch {
      // refresh anyway
      getBrowserAllowlist()
        .then((r) => setDomains(r.domains))
        .catch(() => {})
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          value={newDomain}
          onChange={(e) => setNewDomain(e.target.value)}
          placeholder="github.com"
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          aria-label="Add domain to browser allowlist"
        />
        <Button onClick={handleAdd} disabled={adding || !newDomain.trim()}>
          {adding ? 'Adding…' : 'Add'}
        </Button>
      </div>
      {addError && <p className="text-xs text-ac-red">{addError}</p>}

      {domains.length === 0 ? (
        <p className="text-sm text-ac-muted">
          Allowlist is empty. The agent browser cannot navigate anywhere until you add domains.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {domains.map((d) => (
            <li
              key={d}
              className="flex items-center justify-between py-2 px-3 rounded-btn bg-ac-surface2"
            >
              <span className="text-sm font-mono-code text-ac-text">{d}</span>
              <Button
                size="sm"
                variant="ghost"
                className="text-ac-red hover:text-ac-red hover:bg-ac-red-light min-w-[44px] text-xs"
                onClick={() => handleRemove(d)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function SecurityView({ snapshot }: Props) {
  if (!snapshot) {
    return (
      <div className="flex items-center justify-center h-64 text-ac-muted">
        Connecting…
      </div>
    )
  }

  const { security, feed } = snapshot
  const recentRejections = feed
    .filter((e) => e.outcome === 'rejected')
    .slice(0, 10)

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-medium text-ac-text">Security</h1>
      <p className="text-sm text-ac-muted -mt-2">
        The security layer is always on and cannot be disabled.
      </p>

      {/* Always-on status indicators */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Security layer status</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <StatusBadge label="Injection filter" />
          <StatusBadge label="Permission engine" />
          <StatusBadge label="Audit log" />
          <div className="flex items-center justify-between py-2.5 px-4 rounded-btn bg-ac-surface2">
            <span className="text-sm text-ac-text">Gateway bind</span>
            <span className="text-sm font-mono-code text-ac-teal">{security.gatewayHost}</span>
          </div>
        </CardContent>
      </Card>

      {/* Rejections today */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Rejections</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-end gap-4">
            <span className="text-4xl font-medium text-ac-red leading-none">
              {security.rejectionsToday}
            </span>
            <span className="text-sm text-ac-muted mb-1">today</span>
          </div>
          {security.sparkline7d.length > 0 && (
            <div>
              <p className="text-xs text-ac-muted mb-1">7-day history</p>
              <Sparkline values={security.sparkline7d} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Browser allowlist */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Browser allowlist</CardTitle>
        </CardHeader>
        <CardContent>
          <BrowserAllowlist />
        </CardContent>
      </Card>

      {/* Recent rejected events */}
      {recentRejections.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Recent security events</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 pb-0 divide-y divide-ac-border">
            {recentRejections.map((e, i) => (
              <div
                key={i}
                className="flex items-center gap-3 py-3 px-4"
                style={{ borderLeft: '4px solid #FF5370' }}
              >
                <span className="text-xs text-ac-muted shrink-0 w-16">
                  {formatRelativeTime(e.timestamp)}
                </span>
                <span className="text-sm text-ac-text flex-1 min-w-0 truncate">{e.skill}</span>
                {e.inputSummary && (
                  <span className="text-xs text-ac-muted font-mono-code truncate max-w-[200px]">
                    {e.inputSummary}
                  </span>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Audit integrity note */}
      <p className="text-xs text-ac-hint px-1">
        Audit entries are HMAC-signed and chain-hashed. Use{' '}
        <code className="font-mono-code">npm run export:audit</code> to verify.
      </p>
    </div>
  )
}
