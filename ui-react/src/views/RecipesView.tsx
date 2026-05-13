import { useState } from 'react'
import type { DashboardSnapshot, RecipeWithState } from '@/types/dashboard'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { activateRecipe, deactivateRecipe, setRecipeSchedule } from '@/lib/api'

interface Props {
  snapshot: DashboardSnapshot | null
}

function RecipeRow({ recipe }: { recipe: RecipeWithState }) {
  const [toggling, setToggling] = useState(false)
  const [scheduleValue, setScheduleValue] = useState(recipe.currentSchedule)
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const [scheduleError, setScheduleError] = useState<string | null>(null)

  async function handleToggle(checked: boolean) {
    setToggling(true)
    try {
      if (checked) {await activateRecipe(recipe.id)}
      else {await deactivateRecipe(recipe.id)}
    } finally {
      setToggling(false)
    }
  }

  async function handleScheduleSave() {
    setScheduleError(null)
    setScheduleSaving(true)
    try {
      await setRecipeSchedule(recipe.id, scheduleValue)
    } catch (e) {
      setScheduleError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setScheduleSaving(false)
    }
  }

  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <p className="text-sm font-medium text-ac-text">{recipe.name}</p>
              <Badge variant={recipe.active ? 'success' : 'muted'}>
                {recipe.active ? 'Active' : 'Inactive'}
              </Badge>
            </div>
            <p className="text-xs text-ac-muted mb-1">{recipe.description}</p>
            <p className="text-xs text-ac-hint">
              Skill: {recipe.skill} · {recipe.scheduleLabel}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 min-h-[44px]">
            <Switch
              checked={recipe.active}
              onCheckedChange={handleToggle}
              disabled={toggling}
              aria-label={`Toggle ${recipe.name}`}
            />
          </div>
        </div>

        {/* Custom schedule */}
        <div className="mt-3 flex items-center gap-2">
          <Input
            value={scheduleValue}
            onChange={(e) => setScheduleValue(e.target.value)}
            placeholder="cron expression"
            className="font-mono-code text-xs h-9 flex-1"
            aria-label="Custom cron schedule"
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={handleScheduleSave}
            disabled={scheduleSaving || scheduleValue === recipe.currentSchedule}
          >
            {scheduleSaving ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {scheduleError && (
          <p className="text-xs text-ac-red mt-1">{scheduleError}</p>
        )}
      </CardContent>
    </Card>
  )
}

export function RecipesView({ snapshot }: Props) {
  if (!snapshot) {
    return (
      <div className="flex items-center justify-center h-64 text-ac-muted">
        Connecting…
      </div>
    )
  }

  const { recipes } = snapshot

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium text-ac-text">Recipes</h1>
        <span className="text-sm text-ac-muted">
          {recipes.filter((r) => r.active).length} active
        </span>
      </div>
      <p className="text-sm text-ac-muted -mt-2">
        Named automations that run on a schedule. All recipe runs go through the security layer.
      </p>

      {recipes.length === 0 && (
        <div className="text-sm text-ac-muted py-8 text-center">
          No recipes configured.
        </div>
      )}

      {recipes.map((recipe) => (
        <RecipeRow key={recipe.id} recipe={recipe} />
      ))}
    </div>
  )
}
