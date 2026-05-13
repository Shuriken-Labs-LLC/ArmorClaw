import { useState } from 'react'
import type { DashboardSnapshot, TokenEvent } from '@/types/dashboard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { setBudget, resumeBudgetHardStop } from '@/lib/api'
import { formatCost, formatRelativeTime } from '@/lib/utils'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'

interface Props {
  snapshot: DashboardSnapshot | null
}

function BudgetMeter({ budget }: { budget: DashboardSnapshot['budget'] }) {
  const { spentThisMonthUSD, monthlyBudgetUSD, percentUsed, hardStopActive, atWarning } = budget
  const barColor = percentUsed >= 100 ? 'bg-ac-red' : atWarning ? 'bg-ac-amber' : 'bg-ac-teal'
  const capped = Math.min(percentUsed, 100)

  return (
    <div className="flex flex-col gap-3">
      {hardStopActive && (
        <div className="flex items-center justify-between rounded-btn bg-ac-red-light border border-ac-red/30 px-4 py-3">
          <p className="text-sm text-ac-red">Spending limit reached — agent calls are blocked.</p>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => resumeBudgetHardStop()}
          >
            Resume
          </Button>
        </div>
      )}
      <div className="flex items-end justify-between gap-2">
        <div>
          <span className="text-3xl font-medium text-ac-text">
            {formatCost(spentThisMonthUSD)}
          </span>
          <span className="text-sm text-ac-muted ml-2">
            of {formatCost(monthlyBudgetUSD)}
          </span>
        </div>
        <span
          className={`text-sm font-medium ${percentUsed >= 100 ? 'text-ac-red' : atWarning ? 'text-ac-amber' : 'text-ac-muted'}`}
        >
          {Math.round(percentUsed)}%
        </span>
      </div>
      <Progress value={capped} indicatorClassName={barColor} className="h-2" />
    </div>
  )
}

function DailyChart({ data }: { data: DashboardSnapshot['tokenBurn']['dailyHistory30'] }) {
  const formatted = data.map((d) => ({
    ...d,
    label: d.date.slice(5), // MM-DD
  }))

  return (
    <ResponsiveContainer width="100%" height={160}>
      <BarChart data={formatted} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
        <XAxis
          dataKey="label"
          tick={{ fill: '#8B8DA8', fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          interval={6}
        />
        <YAxis
          tick={{ fill: '#8B8DA8', fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `$${v.toFixed(2)}`}
        />
        <Tooltip
          contentStyle={{
            background: '#13161E',
            border: '0.5px solid #2A2D3A',
            borderRadius: 8,
            color: '#E8E6FF',
            fontSize: 12,
          }}
          formatter={(value: number) => [`$${value.toFixed(4)}`, 'Cost']}
        />
        <Bar dataKey="estimatedCostUSD" radius={[2, 2, 0, 0]}>
          {formatted.map((_, i) => (
            <Cell key={i} fill="#1DE9B6" fillOpacity={0.7} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function SkillBreakdown({
  monthBySkill,
  skills,
}: {
  monthBySkill: Record<string, number>
  skills: DashboardSnapshot['skills']
}) {
  const entries = Object.entries(monthBySkill).toSorted((a, b) => b[1] - a[1])
  if (entries.length === 0) {return <p className="text-sm text-ac-muted">No data yet.</p>}
  const max = entries[0][1]

  function displayName(skillId: string) {
    return skills.find((s) => s.skillId === skillId)?.displayName ?? skillId
  }

  return (
    <div className="flex flex-col gap-2">
      {entries.map(([skillId, cost]) => (
        <div key={skillId} className="flex items-center gap-3">
          <span className="text-sm text-ac-muted w-40 shrink-0 truncate">
            {displayName(skillId)}
          </span>
          <div className="flex-1 h-2 bg-ac-surface2 rounded-full overflow-hidden">
            <div
              className="h-full bg-ac-teal rounded-full"
              style={{ width: `${(cost / max) * 100}%`, opacity: 0.7 }}
            />
          </div>
          <span className="text-sm text-ac-text w-16 text-right shrink-0">
            {formatCost(cost)}
          </span>
        </div>
      ))}
    </div>
  )
}

function RecentEvents({ events }: { events: TokenEvent[] }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Skill</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Model</TableHead>
            <TableHead className="text-right">In</TableHead>
            <TableHead className="text-right">Out</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.slice(0, 50).map((e, i) => (
            <TableRow key={i}>
              <TableCell className="text-xs text-ac-muted whitespace-nowrap">
                {formatRelativeTime(e.timestamp)}
              </TableCell>
              <TableCell className="text-xs">{e.skill}</TableCell>
              <TableCell className="text-xs text-ac-muted">{e.provider}</TableCell>
              <TableCell className="text-xs font-mono-code text-ac-muted">{e.model}</TableCell>
              <TableCell className="text-xs text-right">{e.inputTokens.toLocaleString()}</TableCell>
              <TableCell className="text-xs text-right">{e.outputTokens.toLocaleString()}</TableCell>
              <TableCell className="text-xs text-right font-medium">
                {formatCost(e.estimatedCostUSD)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function ChangeBudget({ current }: { current: number }) {
  const [value, setValue] = useState(String(current))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

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
      setSuccess(true)
      setTimeout(() => setSuccess(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update budget')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ac-muted text-sm">$</span>
          <Input
            type="number"
            min="1"
            step="1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="pl-7"
            aria-label="Monthly budget in USD"
          />
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : success ? 'Saved' : 'Update'}
        </Button>
      </div>
      {error && <p className="text-xs text-ac-red">{error}</p>}
    </div>
  )
}

export function TokenBurnView({ snapshot }: Props) {
  if (!snapshot) {
    return (
      <div className="flex items-center justify-center h-64 text-ac-muted">
        Connecting…
      </div>
    )
  }

  const { budget, tokenBurn, monthTokens, skills } = snapshot

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-medium text-ac-text">Token Burn</h1>

      {/* Budget meter */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Monthly budget</CardTitle>
        </CardHeader>
        <CardContent>
          <BudgetMeter budget={budget} />
        </CardContent>
      </Card>

      {/* Today summary */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Today</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-ac-muted mb-1">Input tokens</p>
            <p className="text-xl font-medium text-ac-text">
              {tokenBurn.todayTokens.inputTokens.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-ac-muted mb-1">Output tokens</p>
            <p className="text-xl font-medium text-ac-text">
              {tokenBurn.todayTokens.outputTokens.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-ac-muted mb-1">Estimated cost</p>
            <p className="text-xl font-medium text-ac-text">
              {formatCost(tokenBurn.todayTokens.estimatedCostUSD)}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Month by skill */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Spend by skill (this month)</CardTitle>
        </CardHeader>
        <CardContent>
          <SkillBreakdown monthBySkill={tokenBurn.monthBySkill} skills={skills} />
        </CardContent>
      </Card>

      {/* 30-day chart */}
      {tokenBurn.dailyHistory30.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>30-day cost history</CardTitle>
          </CardHeader>
          <CardContent>
            <DailyChart data={tokenBurn.dailyHistory30} />
          </CardContent>
        </Card>
      )}

      {/* This month totals */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>This month</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-ac-muted mb-1">Input tokens</p>
            <p className="text-xl font-medium text-ac-text">
              {monthTokens.inputTokens.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-ac-muted mb-1">Output tokens</p>
            <p className="text-xl font-medium text-ac-text">
              {monthTokens.outputTokens.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-ac-muted mb-1">Total cost</p>
            <p className="text-xl font-medium text-ac-text">
              {formatCost(monthTokens.estimatedCostUSD)}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Recent events */}
      {tokenBurn.recentEvents.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Recent token events</CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-2">
            <RecentEvents events={tokenBurn.recentEvents} />
          </CardContent>
        </Card>
      )}

      {/* Change budget */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Change monthly budget</CardTitle>
        </CardHeader>
        <CardContent>
          <ChangeBudget current={budget.monthlyBudgetUSD} />
        </CardContent>
      </Card>
    </div>
  )
}
