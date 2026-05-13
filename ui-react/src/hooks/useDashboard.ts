import { useEffect, useRef, useState } from 'react'
import type { DashboardSnapshot } from '@/types/dashboard'
import { getDashboard } from '@/lib/api'

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''
const SSE_URL = `${BASE}/api/events`

const BACKOFF_INITIAL_MS = 1_000
const BACKOFF_MAX_MS = 30_000

export function useDashboard() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const backoffRef = useRef(BACKOFF_INITIAL_MS)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function connect() {
    if (esRef.current) {
      esRef.current.close()
    }

    const es = new EventSource(SSE_URL)
    esRef.current = es

    es.onopen = () => {
      setConnected(true)
      setError(null)
      backoffRef.current = BACKOFF_INITIAL_MS
    }

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as DashboardSnapshot
        setSnapshot(data)
      } catch {
        // malformed frame — ignore
      }
    }

    es.onerror = () => {
      setConnected(false)
      es.close()
      esRef.current = null

      const delay = backoffRef.current
      backoffRef.current = Math.min(delay * 2, BACKOFF_MAX_MS)

      retryTimerRef.current = setTimeout(connect, delay)
    }
  }

  useEffect(() => {
    // Seed with a one-shot fetch before SSE is established
    getDashboard()
      .then(setSnapshot)
      .catch(() => setError('Could not reach ArmorClaw server'))

    connect()

    return () => {
      esRef.current?.close()
      if (retryTimerRef.current) {clearTimeout(retryTimerRef.current)}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { snapshot, connected, error }
}
