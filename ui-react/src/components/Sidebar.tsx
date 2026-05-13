import { NavLink } from 'react-router-dom'
import {
  Home,
  Puzzle,
  CalendarClock,
  ShieldCheck,
  Flame,
  Terminal,
  Settings,
  Menu,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/skills', label: 'Skills', icon: Puzzle },
  { to: '/recipes', label: 'Recipes', icon: CalendarClock },
  { to: '/security', label: 'Security', icon: ShieldCheck },
  { to: '/token-burn', label: 'Token Burn', icon: Flame },
  { to: '/advanced', label: 'Advanced', icon: Terminal },
  { to: '/settings', label: 'Settings', icon: Settings },
]

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <aside
      className={cn(
        'fixed left-0 top-0 h-screen bg-ac-surface flex flex-col z-40 transition-all duration-200',
        collapsed ? 'w-16' : 'w-sidebar',
      )}
      style={{ borderRight: '0.5px solid #2A2D3A' }}
    >
      {/* Brand */}
      <div className="flex items-center gap-3 px-4 py-5 min-h-[64px]">
        <div
          className="shrink-0 w-8 h-8 rounded-btn flex items-center justify-center text-sm font-mono-code font-medium"
          style={{ background: 'linear-gradient(135deg, #1DE9B6 0%, #9B6DFF 100%)' }}
        >
          <span className="text-ac-bg font-bold text-xs">AC</span>
        </div>
        {!collapsed && (
          <span className="text-ac-text font-medium text-sm leading-none">ArmorClaw</span>
        )}
        <button
          onClick={onToggle}
          className={cn(
            'ml-auto text-ac-muted hover:text-ac-text transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center rounded-btn hover:bg-ac-surface2',
            collapsed && 'ml-0',
          )}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <Menu size={16} /> : <X size={16} />}
        </button>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-1 px-2 flex-1 overflow-y-auto">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-btn text-sm transition-all min-h-[44px] hover-glow',
                isActive
                  ? 'bg-ac-teal-light text-ac-teal font-medium'
                  : 'text-ac-muted hover:text-ac-text hover:bg-ac-surface2',
                collapsed && 'justify-center px-0',
              )
            }
            title={collapsed ? label : undefined}
          >
            <Icon size={18} className="shrink-0" />
            {!collapsed && <span>{label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-4">
        {!collapsed && (
          <p className="text-xs text-ac-hint">v0.1.0 · localhost only</p>
        )}
      </div>
    </aside>
  )
}

export function MobileSidebarTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="fixed top-4 left-4 z-50 md:hidden bg-ac-surface border border-ac-border rounded-btn p-2.5 text-ac-muted hover:text-ac-text min-w-[44px] min-h-[44px] flex items-center justify-center"
      aria-label="Open menu"
    >
      <Menu size={18} />
    </button>
  )
}

export function MobileSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={cn(
          'fixed left-0 top-0 h-screen w-sidebar bg-ac-surface z-50 flex flex-col transition-transform duration-200 md:hidden',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        style={{ borderRight: '0.5px solid #2A2D3A' }}
      >
        <div className="flex items-center gap-3 px-4 py-5 min-h-[64px]">
          <div
            className="shrink-0 w-8 h-8 rounded-btn flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #1DE9B6 0%, #9B6DFF 100%)' }}
          >
            <span className="text-ac-bg font-bold text-xs">AC</span>
          </div>
          <span className="text-ac-text font-medium text-sm">ArmorClaw</span>
          <button
            onClick={onClose}
            className="ml-auto text-ac-muted hover:text-ac-text min-w-[44px] min-h-[44px] flex items-center justify-center rounded-btn"
          >
            <X size={16} />
          </button>
        </div>
        <nav className="flex flex-col gap-1 px-2 flex-1">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-btn text-sm transition-all min-h-[44px]',
                  isActive
                    ? 'bg-ac-teal-light text-ac-teal font-medium'
                    : 'text-ac-muted hover:text-ac-text hover:bg-ac-surface2',
                )
              }
            >
              <Icon size={18} className="shrink-0" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
    </>
  )
}

export function useSidebarState() {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  return {
    collapsed,
    mobileOpen,
    toggle: () => setCollapsed((c) => !c),
    openMobile: () => setMobileOpen(true),
    closeMobile: () => setMobileOpen(false),
  }
}
