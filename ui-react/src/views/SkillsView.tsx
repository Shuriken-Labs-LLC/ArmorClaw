import { useEffect, useState } from 'react'
import type { DashboardSnapshot, BundledSkillStatus } from '@/types/dashboard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { getBundledSkills } from '@/lib/api'
import { formatRelativeTime, permissionToEnglish } from '@/lib/utils'

interface Props {
  snapshot: DashboardSnapshot | null
}

export function SkillsView({ snapshot }: Props) {
  const [bundledStatuses, setBundledStatuses] = useState<BundledSkillStatus[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    getBundledSkills()
      .then(setBundledStatuses)
      .catch(() => {})
  }, [])

  if (!snapshot) {
    return (
      <div className="flex items-center justify-center h-64 text-ac-muted">
        Connecting…
      </div>
    )
  }

  const skills = snapshot.skills

  function getStatus(skillId: string): BundledSkillStatus | undefined {
    return bundledStatuses.find((s) => s.id === skillId)
  }

  function getLastRun(skillId: string): string | null {
    const entry = snapshot?.feed.find((e) => e.skill === skillId)
    return entry ? formatRelativeTime(entry.timestamp) : null
  }

  function getLast5(skillId: string) {
    return snapshot?.feed.filter((e) => e.skill === skillId).slice(0, 5) ?? []
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-medium text-ac-text">ArmorClaw skills</h1>
      <p className="text-sm text-ac-muted -mt-2">
        Three bundled skills. User-defined skills are not supported.
      </p>

      {skills.length === 0 && (
        <div className="text-sm text-ac-muted py-8 text-center">
          No skills registered. The daemon may still be starting.
        </div>
      )}

      {skills.map((skill) => {
        const status = getStatus(skill.skillId)
        const lastRun = getLastRun(skill.skillId)
        const last5 = getLast5(skill.skillId)
        const isExpanded = expanded === skill.skillId
        const isConfigured = status?.status !== 'not_configured'

        return (
          <Card key={skill.skillId}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <CardTitle className="text-base">{skill.displayName}</CardTitle>
                  <span className="text-xs text-ac-muted font-mono-code">v{skill.version}</span>
                  <Badge variant={isConfigured ? 'success' : 'muted'}>
                    {isConfigured ? 'Active' : 'Not configured'}
                  </Badge>
                </div>
                {lastRun && (
                  <span className="text-xs text-ac-muted">Last run {lastRun}</span>
                )}
              </div>
              <p className="text-sm text-ac-muted pt-1">{skill.description}</p>
            </CardHeader>

            <CardContent className="flex flex-col gap-3">
              {/* Permissions */}
              {skill.permissionManifest.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-ac-muted uppercase tracking-wide mb-1.5">
                    Permissions
                  </p>
                  <ul className="flex flex-col gap-1">
                    {skill.permissionManifest.map((p) => (
                      <li key={p} className="text-sm text-ac-text flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-ac-teal shrink-0" />
                        {permissionToEnglish(p)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Missing config message */}
              {status?.missingConfig && (
                <div className="rounded-btn bg-ac-amber-light px-3 py-2 text-sm text-ac-amber">
                  {status.missingConfig}
                </div>
              )}

              {/* Expandable last 5 runs */}
              <button
                className="text-xs text-ac-muted hover:text-ac-text text-left mt-1"
                onClick={() => setExpanded(isExpanded ? null : skill.skillId)}
              >
                {isExpanded ? '▲ Hide last 5 runs' : '▼ Last 5 runs'}
              </button>

              {isExpanded && (
                <div className="flex flex-col gap-1 mt-1">
                  {last5.length === 0 ? (
                    <p className="text-xs text-ac-hint">No runs yet.</p>
                  ) : (
                    last5.map((entry, i) => {
                      const borderColor =
                        entry.outcome === 'success'
                          ? '#1DE9B6'
                          : entry.outcome === 'undone'
                          ? '#FFB347'
                          : '#FF5370'
                      return (
                        <div
                          key={i}
                          className="flex items-center gap-3 py-2 px-3 rounded-btn bg-ac-surface2 text-xs"
                          style={{ borderLeft: `3px solid ${borderColor}` }}
                        >
                          <span className="text-ac-muted">{formatRelativeTime(entry.timestamp)}</span>
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
                          <span className="text-ac-muted ml-auto">{entry.durationMs}ms</span>
                        </div>
                      )
                    })
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
