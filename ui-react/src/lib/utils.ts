import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return '$0.00'
  if (usd < 1) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(2)}`
}

export function formatRelativeTime(isoString: string): string {
  const now = Date.now()
  const then = new Date(isoString).getTime()
  const diff = now - then
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export function formatCountdown(isoString: string): number {
  return Math.max(0, Math.round((new Date(isoString).getTime() - Date.now()) / 1000))
}

export function permissionToEnglish(permission: string): string {
  const map: Record<string, string> = {
    'read:files': 'Read files in sandbox',
    'write:files': 'Write files in sandbox',
    'read:email': 'Read email (no sending)',
    'send:email': 'Send email (with confirmation)',
    'read:calendar': 'Read calendar events',
    'write:calendar': 'Create and edit calendar events',
    'browser:sandboxed': 'Control dedicated browser profile',
    'network:outbound': 'Outbound HTTP to allowlisted domains',
  }
  return map[permission] ?? permission
}
