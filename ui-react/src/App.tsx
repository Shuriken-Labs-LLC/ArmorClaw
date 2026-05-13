import { HashRouter, Routes, Route } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { useDashboard } from '@/hooks/useDashboard'
import {
  Sidebar,
  MobileSidebar,
  MobileSidebarTrigger,
  useSidebarState,
} from '@/components/Sidebar'
import { HomeView } from '@/views/HomeView'
import { SkillsView } from '@/views/SkillsView'
import { RecipesView } from '@/views/RecipesView'
import { SecurityView } from '@/views/SecurityView'
import { TokenBurnView } from '@/views/TokenBurnView'
import { AdvancedView } from '@/views/AdvancedView'
import { SettingsView } from '@/views/SettingsView'

function Shell() {
  const { snapshot, connected, error } = useDashboard()
  const { collapsed, mobileOpen, toggle, openMobile, closeMobile } = useSidebarState()

  return (
    <div className="flex min-h-screen bg-ac-bg">
      {/* Desktop sidebar */}
      <div className="hidden md:block">
        <Sidebar collapsed={collapsed} onToggle={toggle} />
      </div>

      {/* Mobile sidebar */}
      <MobileSidebarTrigger onClick={openMobile} />
      <MobileSidebar open={mobileOpen} onClose={closeMobile} />

      {/* Main content */}
      <main
        className={cn(
          'flex-1 min-h-screen transition-all duration-200',
          'md:ml-sidebar',
          collapsed && 'md:ml-16',
        )}
      >
        {/* Connection status banner */}
        {!connected && !error && (
          <div className="w-full bg-ac-amber-light border-b border-ac-amber/30 px-6 py-2 text-xs text-ac-amber">
            Reconnecting to ArmorClaw server…
          </div>
        )}
        {error && (
          <div className="w-full bg-ac-red-light border-b border-ac-red/30 px-6 py-2 text-xs text-ac-red">
            {error}
          </div>
        )}

        <div className="p-4 md:p-6 max-w-5xl mx-auto pt-16 md:pt-6">
          <Routes>
            <Route path="/" element={<HomeView snapshot={snapshot} />} />
            <Route path="/skills" element={<SkillsView snapshot={snapshot} />} />
            <Route path="/recipes" element={<RecipesView snapshot={snapshot} />} />
            <Route path="/security" element={<SecurityView snapshot={snapshot} />} />
            <Route path="/token-burn" element={<TokenBurnView snapshot={snapshot} />} />
            <Route path="/advanced" element={<AdvancedView snapshot={snapshot} />} />
            <Route path="/settings" element={<SettingsView snapshot={snapshot} />} />
          </Routes>
        </div>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  )
}
