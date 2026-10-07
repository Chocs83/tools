export type WbSummary = {
  goal: string
  done: string[]
  now: string
  next: string
  updatedAt: number
  source: 'auto' | 'fork'
}

export type WbLive = {
  isRunning: boolean
  startedAt: number
  tools: number
  lastAction: string
}

export type WbTask = {
  id: string
  label: string
  kind: 'bash' | 'monitor'
  startedAt: number
  endedAt?: number
  status: 'running' | 'completed' | 'failed' | 'killed'
  tail: string
  outputPath?: string
}

export type WbLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type WbUsage = {
  ctxPercent?: number
  ctxTokens?: number
  ctxWindow: number
  limits: WbLimit[]
}

/** ccusage figures: today and month to date, in USD at API prices. */
export type WbCost = {
  today: number
  todayTokens: number
  month: number
  monthTokens: number
  monthStart: string
  updatedAt: number
  error?: string
}

export type WbDevice = {
  user: string
  ip: string
  hostname?: string
  model?: string
  addedAt: number
  lastSeen?: number
  lastChecked?: number
  online: boolean
  pingable?: boolean
  tempC?: number
  throttled?: number
}

/** The taximeter's running figures, in USD; the session's own ledger moves the meter between ccusage runs. */
export type WbMeter = {
  sessionUsd?: number
  baseSessionUsd?: number
  rideStartUsd?: number
  lastRide?: { usd: number; endedAt: number }
  tokPerSec?: number
}

export type WbModel = { model: string; effort?: string }

export type WbFile = { path: string; mtime: number; size: number }

declare module 'claude-code' {
  interface PluginState {
    workbench: {
      summary: WbSummary | null
      summaryBusy: boolean
      summaryError: string
      autoSummary: boolean
      live: WbLive
      tasks: WbTask[]
      usage: WbUsage | null
      model: WbModel | null
      meter: WbMeter
      usageView: 'gui' | 'text'
      cost: WbCost | null
      devices: WbDevice[]
      files: WbFile[]
      fileKinds: string[]
      tzOffsetMin: number
      tick: number
    }
  }
}
