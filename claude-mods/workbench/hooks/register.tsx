import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import { CAR_WIDTH, bitmapWidth, groupThousands, tallBitmap, taxiCar, textBitmap, toRaster, toRasterPalette } from './taxi'
import type { WbCost, WbDevice, WbFile, WbLimit, WbSummary, WbTask, WbUsage } from '../types'

type $T = EngineInterface

const PANE = 'workbench'
const TITLE = '작업대'

const summaryA = atom({ plugin: 'workbench', key: 'summary' } as const, null)
const summaryBusyA = atom({ plugin: 'workbench', key: 'summaryBusy' } as const, false)
const summaryErrorA = atom({ plugin: 'workbench', key: 'summaryError' } as const, '')
const autoSummaryA = atom({ plugin: 'workbench', key: 'autoSummary' } as const, true)
const liveA = atom({ plugin: 'workbench', key: 'live' } as const, {
  isRunning: false,
  startedAt: 0,
  tools: 0,
  lastAction: '',
})
const tasksA = atom({ plugin: 'workbench', key: 'tasks' } as const, [])
const usageA = atom({ plugin: 'workbench', key: 'usage' } as const, null)
const meterA = atom({ plugin: 'workbench', key: 'meter' } as const, {})
const modelA = atom({ plugin: 'workbench', key: 'model' } as const, null)
const costA = atom({ plugin: 'workbench', key: 'cost' } as const, null)
const devicesA = atom({ plugin: 'workbench', key: 'devices' } as const, [])
const filesA = atom({ plugin: 'workbench', key: 'files' } as const, [])
const fileKindsA = atom({ plugin: 'workbench', key: 'fileKinds' } as const, ['img', 'md', 'doc'])
const tzA = atom({ plugin: 'workbench', key: 'tzOffsetMin' } as const, 0)
const tickA = atom({ plugin: 'workbench', key: 'tick' } as const, 0)

const CCUSAGE = 'ccusage@20.0.26'
const COST_EVERY_MS = 5 * 60_000
const COST_AFTER_TURN_MIN_MS = 60_000
const DEVICE_EVERY_MS = 30_000
const FILES_EVERY_MS = 30_000
const SHOW_FINISHED_MS = 10 * 60_000
const KEEP_FINISHED = 6
// Fixed rate for the meter's 원 figure; the USD figures stay exact beside it.
const KRW_PER_USD = 1400
const PAY_SHOW_MS = 15_000
const LCD_BG = 0x141414
const DIGIT_FG = 0xf2f2f2
const BODY_GRAY = 0x8a8a8a
const BODY_GREEN = 0x7cdb6e

type TaxiState = '빈차' | '주행' | '할증' | '복합' | '지불'

const taxiStateOf = (
  live: { isRunning: boolean },
  meter: { lastRide?: { endedAt: number } },
  tasks: readonly WbTask[],
  ctxPct: number | undefined,
  now: number,
): TaxiState => {
  if (live.isRunning) {
    if ((ctxPct ?? 0) >= 70) return '할증'
    return tasks.some(t => t.status === 'running') ? '복합' : '주행'
  }
  return meter.lastRide && now - meter.lastRide.endedAt < PAY_SHOW_MS ? '지불' : '빈차'
}

const mix = (a: number, b: number, t: number) => {
  const k = Math.min(1, Math.max(0, t))
  const ch = (sh: number) => Math.round(((a >> sh) & 255) * (1 - k) + ((b >> sh) & 255) * k) << sh
  return ch(16) | ch(8) | ch(0)
}

/** The taxi's body: 빈차·지불 gray, 주행·복합 green, 할증 yellow at 70% context going red at 100%. */
const bodyColor = (state: TaxiState, ctxPct: number | undefined) =>
  state === '할증' ? mix(0xffd84a, 0xff3b3b, ((ctxPct ?? 70) - 70) / 30) : state === '주행' || state === '복합' ? BODY_GREEN : BODY_GRAY

const carPalette = (body: number): Record<string, number> => ({
  Y: 0xffd84a,
  B: body,
  W: 0x9fd3ff,
  L: 0xfff3b0,
  K: 0x3a3a3a,
  C: 0xb8b8b8,
  D: 0x4a4a4a,
  R: 0xf2f2f2,
  S: 0x8a8a8a,
})

// How fast the model is writing right now, from the streamed pieces (about 4 characters a token).
const streamSamples: { t: number; n: number }[] = []
const STREAM_WINDOW_MS = 1500
const noteStreamed = (n: number) => {
  const t = Date.now()
  streamSamples.push({ t, n })
  while (streamSamples.length && t - (streamSamples[0]?.t ?? t) > STREAM_WINDOW_MS) streamSamples.shift()
}
const liveTokRate = () => {
  const t = Date.now()
  let n = 0
  for (const s of streamSamples) if (t - s.t <= STREAM_WINDOW_MS) n += s.n
  return n / 4 / (STREAM_WINDOW_MS / 1000)
}
/** Milliseconds per animation step: a crawl while tools run, flat out at 120+ tok/s. */
const stepInterval = (tokPerSec: number) => (tokPerSec < 5 ? 420 : Math.min(420, Math.max(90, 520 - tokPerSec * 3.5)))

let carStep = 0

// ---------- formatting ----------

const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

const fmtAgo = (ms: number): string => {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return '방금'
  if (m < 60) return `${m}분 전`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}시간 전`
  return `${Math.floor(h / 24)}일 전`
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Local wall-clock parts for an epoch ms, from the host's offset (the sandbox has no TZ). */
const local = (t: number, tzMin: number) => {
  const d = new Date(t + tzMin * 60_000)
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hm: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`,
  }
}

/** Time left until a limit window resets ("4h50m 남음"). */
const fmtLeft = (iso: string | undefined, now: number): string => {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t) || t <= now) return ''
  return `(${fmtDur(t - now)})`
}

const bar = (pct: number, width: number): string => {
  const w = Math.max(4, width)
  const f = Math.min(w, Math.max(0, Math.round((pct / 100) * w)))
  return '█'.repeat(f) + '░'.repeat(w - f)
}

const levelColor = (pct: number) => (pct >= 85 ? 'error' : pct >= 60 ? 'warning' : 'success')

const kTokens = (n: number | undefined) =>
  n === undefined ? '?' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`

const usd = (n: number) => `$${n.toFixed(2)}`

const limitLabel = (kind: string) =>
  kind === 'five_hour' ? '5시간' : kind === 'seven_day' ? '7일' : kind === 'seven_day_opus' ? '7일 Opus' : kind

/** "claude-opus-5-5[1m]" -> "Opus 5.5 1M" */
const modelName = (id: string) => {
  const m = id.match(/(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/i)
  const ctx = /\[1m\]/i.test(id) ? ' 1M' : ''
  if (!m) return id.replace(/^claude-/, '') + ctx
  const fam = (m[1] ?? '').charAt(0).toUpperCase() + (m[1] ?? '').slice(1).toLowerCase()
  return `${fam} ${m[2]}${m[3] ? '.' + m[3] : ''}${ctx}`
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]/g

const cleanLine = (raw: string): string => {
  let s = raw.replace(ANSI, '')
  if (s.endsWith('\r')) s = s.slice(0, -1)
  const cr = s.lastIndexOf('\r')
  if (cr >= 0) s = s.slice(cr + 1)
  return s.replace(/\t/g, '  ')
}

/** The last visible line of a log tail, \r-overwritten progress collapsed to what shows. */
const lastLine = (text: string): string => {
  const lines = text.split('\n').map(cleanLine).filter(l => l.trim() !== '')
  return lines[lines.length - 1] ?? ''
}

/** How far along a log line says it is: a percentage, else the last n/m. */
const progressOf = (line: string): number | undefined => {
  const pcts = [...line.matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)].map(m => Number(m[1])).filter(p => p <= 100)
  if (pcts.length) return pcts[pcts.length - 1]
  const fracs = [...line.matchAll(/(\d+)\s*\/\s*(\d+)/g)]
    .map(m => [Number(m[1]), Number(m[2])] as const)
    .filter(([a, b]) => b > 1 && a <= b)
  const last = fracs[fracs.length - 1]
  return last ? (100 * last[0]) / last[1] : undefined
}

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => {
      if (b && typeof b === 'object') {
        const o = b as Record<string, unknown>
        if (typeof o.text === 'string') return o.text
        if (o.content !== undefined) return textOf(o.content)
      }
      return ''
    })
    .join('\n')
}

// ---------- the summary ----------

const SUMMARY_SYSTEM =
  '너는 개발 세션 옆 사이드바에 띄울 "현재 작업" 카드를 쓰는 요약기다. 반드시 JSON 한 개만 출력한다. ' +
  '형식: {"goal":"...","done":["...","..."],"now":"...","next":"..."} . ' +
  'goal=사용자가 이 세션에서 이루려는 것(한 줄), done=최근 끝낸 것 최대 3개, now=지금 하고 있는 것, ' +
  'next=다음 단계(모르면 빈 문자열). 모두 한국어, 각 항목 45자 이내, 군더더기 없이 명사형으로.'

const FORK_PROMPT =
  '이 세션 옆 사이드바에 띄울 "현재 작업" 카드를 만들어줘. 도구는 쓰지 말고 JSON 한 개만 출력해. ' +
  '형식: {"goal":"...","done":["..."],"now":"...","next":"..."} . goal=이 세션 전체의 목표, ' +
  'done=지금까지 끝낸 핵심 성과 최대 3개(숫자 포함), now=현재 진행 중인 것, next=남은 다음 단계. ' +
  '모두 한국어, 각 45자 이내.'

/** What the card is made from, read from the transcript itself so a reload or resume loses nothing. */
const buildDigest = async ($: $T, prev: WbSummary | null): Promise<string | null> => {
  const messages = await $.session.messages()
  const prompts: string[] = []
  const actions: string[] = []
  let answer = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    if (m.role === 'user') {
      const t = m.text.trim()
      // Skip engine rows (task notifications, command wrappers, reminders).
      if (t && !t.startsWith('<') && prompts.length < 4) prompts.unshift(clip(t, 400))
    } else {
      if (!answer && m.text.trim()) answer = m.text.trim()
      for (let j = m.toolUses.length - 1; j >= 0 && actions.length < 20; j--) {
        const u = m.toolUses[j]
        if (u) actions.unshift(clip(describeCall({ tool: u.tool, ...u.input }), 90))
      }
    }
    if (prompts.length >= 4 && actions.length >= 20 && answer) break
  }
  if (!prompts.length && !answer) return null
  const parts: string[] = []
  if (prev) {
    parts.push(
      '[이전 카드]\n' + JSON.stringify({ goal: prev.goal, done: prev.done, now: prev.now, next: prev.next }),
    )
  }
  if (prompts.length) parts.push('[최근 사용자 요청]\n' + prompts.map(p => '- ' + p).join('\n'))
  if (actions.length) parts.push('[최근 도구 작업]\n' + actions.map(a => '- ' + a).join('\n'))
  if (answer) parts.push('[어시스턴트의 마지막 답변]\n' + clip(answer, 2500))
  parts.push(
    '위 개발 세션 기록으로 카드를 갱신해. 이전 카드의 goal 은 주제가 바뀌지 않았으면 유지해.\n' +
      '출력은 {"goal":"...","done":["..."],"now":"...","next":"..."} 형식의 JSON 한 개뿐이다. 인사·설명·코드펜스 금지.',
  )
  return parts.join('\n\n')
}

const parseSummary = (text: string, source: WbSummary['source'], now: number): WbSummary | null => {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const o = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    const done = Array.isArray(o.done) ? o.done.map(str).filter(Boolean).slice(0, 3) : []
    return { goal: str(o.goal), done, now: str(o.now), next: str(o.next), updatedAt: now, source }
  } catch {
    return null
  }
}

const summarize = async ($: $T, source: WbSummary['source']) => {
  if (await read($, summaryBusyA)) return
  await update($, summaryBusyA, () => true)
  try {
    const prev = await read($, summaryA)
    const digest = source === 'fork' ? FORK_PROMPT : await buildDigest($, prev)
    if (digest === null) {
      await update($, summaryErrorA, () => '아직 요약할 대화가 없습니다')
      return
    }
    const r =
      source === 'fork'
        ? await $.model.fork({ prompt: FORK_PROMPT })
        : await $.model.complete({
            model: 'haiku',
            system: SUMMARY_SYSTEM,
            prompt: digest,
            maxTokens: 600,
            effort: 'low',
          })
    if (!r.isAnswered) {
      const detail = r.reason === 'api-error' ? ` ${String((r as { status?: number }).status ?? '')}` : ''
      await update($, summaryErrorA, () => `${r.reason}${detail}`)
      return
    }
    const card = parseSummary(r.text, source, await $.clock.now())
    if (card) {
      await update($, summaryA, () => card)
      await update($, summaryErrorA, () => '')
    } else {
      await update($, summaryErrorA, () => `응답 해석 실패: ${clip(r.text.replace(/\s+/g, ' '), 60)}`)
    }
  } catch (err) {
    await update($, summaryErrorA, () => String((err as Error)?.message ?? err))
  } finally {
    await update($, summaryBusyA, () => false)
  }
}

// ---------- background tasks ----------

const upsertTask = async ($: $T, id: string, fn: (t: WbTask | undefined) => WbTask | undefined) => {
  await update($, tasksA, list => {
    const out: WbTask[] = []
    let seen = false
    for (const t of list) {
      if (t.id === id) {
        seen = true
        const changed = fn(t)
        if (changed) out.push(changed)
      } else {
        out.push(t)
      }
    }
    if (!seen) {
      const added = fn(undefined)
      if (added) out.push(added)
    }
    const finished = out.filter(t => t.status !== 'running').sort((x, y) => (x.endedAt ?? 0) - (y.endedAt ?? 0))
    if (finished.length <= KEEP_FINISHED) return out
    const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map(t => t.id))
    return out.filter(t => !drop.has(t.id))
  })
}

const onNotifications = async ($: $T, text: string) => {
  const now = await $.clock.now()
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = m[1] ?? ''
    const id = body.match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim()
    if (!id) continue
    const status = body.match(/<status>([^<]+)<\/status>/)?.[1]?.trim()
    const summary = unescapeXml(body.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? '')
    const event = unescapeXml(body.match(/<event>([\s\S]*?)<\/event>/)?.[1] ?? '')
    const outputPath = body.match(/<output-file>([^<]+)<\/output-file>/)?.[1]?.trim()
    const monitorEnded = /\[Monitor (timed out|stopped|ended|exited)/i.test(event)
    const mapped: WbTask['status'] | undefined =
      status === 'completed'
        ? 'completed'
        : status === 'failed'
          ? 'failed'
          : status === 'killed' || status === 'stopped'
            ? 'killed'
            : monitorEnded
              ? 'completed'
              : undefined
    await upsertTask($, id, t => {
      const base: WbTask = t ?? {
        id,
        label: clip(summary.replace(/^Monitor event: /, '').replace(/^"|"$/g, '') || id, 60),
        kind: event ? 'monitor' : 'bash',
        startedAt: now,
        status: 'running',
        tail: '',
        outputPath,
      }
      const tail = event && !monitorEnded ? lastLine(event) : base.tail
      if (mapped && base.status === 'running') return { ...base, status: mapped, endedAt: now, tail }
      return { ...base, tail }
    })
  }
}

const pollTails = async ($: $T) => {
  const tasks = await read($, tasksA)
  for (const t of tasks) {
    if (t.status !== 'running' || t.kind !== 'bash' || !t.outputPath) continue
    const r = await $.process.run(['tail', '-c', '4000', t.outputPath], { timeoutMs: 3000 })
    if (r.exitCode !== 0) continue
    const tail = lastLine(r.stdout)
    if (tail && tail !== t.tail) await upsertTask($, t.id, x => (x ? { ...x, tail } : x))
  }
}

const describeCall = (e: Record<string, unknown>): string => {
  const tool = String(e.tool)
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  switch (tool) {
    case 'Bash':
      return s('description') || clip(s('command').split('\n')[0] ?? '', 70)
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `${tool} ${basename(s('file_path') || s('notebook_path'))}`
    case 'Monitor':
    case 'Agent':
      return `${tool}: ${s('description')}`
    case 'Skill':
      return `Skill ${s('skill')}`
    default:
      return tool.replace(/^mcp__/, '')
  }
}

// ---------- usage: live limits + ccusage cost ----------

const setUsage = async (
  $: $T,
  u: {
    context: { tokens?: number; window: number; percent?: number }
    rateLimits: readonly WbLimit[]
    cost?: { usd: number }
  },
) => {
  const usdNow = u.cost?.usd
  if (usdNow !== undefined) await update($, meterA, m => (m.sessionUsd === usdNow ? m : { ...m, sessionUsd: usdNow }))
  const next: WbUsage = {
    ctxPercent: u.context.percent,
    ctxTokens: u.context.tokens,
    ctxWindow: u.context.window,
    limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  }
  await update($, usageA, () => next)
}

let costBusy = false
let costAt = 0

const refreshCost = async ($: $T) => {
  if (costBusy) return
  costBusy = true
  try {
    const now = await $.clock.now()
    const tz = await read($, tzA)
    const l = local(now, tz)
    const today = `${l.y}-${pad2(l.mo)}-${pad2(l.d)}`
    const since = `${l.y}${pad2(l.mo)}01`
    const home = (await $.env.get('HOME')) ?? '/'
    const counted = (await read($, meterA)).sessionUsd
    const args = ['-y', CCUSAGE, 'daily', '--json', '--since', since]
    let r = await $.process.run(['npx', ...args], { cwd: home, timeoutMs: 180_000 })
    // No network: fall back to ccusage's cached prices rather than show nothing.
    if (r.exitCode !== 0) r = await $.process.run(['npx', ...args, '--offline'], { cwd: home, timeoutMs: 180_000 })
    const at = await $.clock.now()
    costAt = at
    if (r.exitCode !== 0) {
      const why = lastLine(r.stderr) || `exit ${r.exitCode}`
      await update($, costA, c => (c ? { ...c, error: why } : c))
      return
    }
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as {
      daily?: { period?: string; date?: string; totalCost?: number; totalTokens?: number }[]
      totals?: { totalCost?: number; totalTokens?: number }
    }
    const day = (j.daily ?? []).find(d => (d.period ?? d.date) === today)
    const next: WbCost = {
      today: day?.totalCost ?? 0,
      todayTokens: day?.totalTokens ?? 0,
      month: j.totals?.totalCost ?? 0,
      monthTokens: j.totals?.totalTokens ?? 0,
      monthStart: `${l.mo}/1`,
      updatedAt: at,
    }
    await update($, costA, () => next)
    await update($, meterA, m => ({ ...m, baseSessionUsd: counted }))
  } catch (err) {
    await update($, costA, c => (c ? { ...c, error: String((err as Error)?.message ?? err) } : c))
  } finally {
    costBusy = false
  }
}

// ---------- devices ----------

const DEVICE_STORE = 'devices'
const IP_RE = /\b([a-z_][\w-]*)@(\d{1,3}(?:\.\d{1,3}){3})\b/g
const PROBE =
  'hostname; cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo -; ' +
  "vcgencmd get_throttled 2>/dev/null || echo -; tr -d '\\0' < /proc/device-tree/model 2>/dev/null || echo -"

const boardOf = (model: string | undefined) => {
  if (!model) return ''
  const cm = model.match(/Compute Module (\d+)/i)
  if (cm) return `CM${cm[1]}`
  const pi = model.match(/Raspberry Pi (\d+)/i)
  return pi ? `Pi${pi[1]}` : clip(model, 12)
}

const saveDevices = async ($: $T, list: WbDevice[]) => {
  await update($, devicesA, () => list)
  // Kept across sessions so "last IP / last seen" survives a restart.
  await $.store.set(
    DEVICE_STORE,
    list.map(d => ({ ...d, online: false, pingable: undefined })),
  )
}

const learnDevices = async ($: $T, command: string) => {
  if (!/\b(ssh|scp|rsync|sftp)\b/.test(command)) return
  const found = [...command.matchAll(IP_RE)].map(m => ({ user: m[1] ?? '', ip: m[2] ?? '' }))
  if (!found.length) return
  const now = await $.clock.now()
  const list = await read($, devicesA)
  let changed = false
  const next = [...list]
  for (const f of found) {
    if (next.some(d => d.ip === f.ip)) continue
    next.push({ user: f.user, ip: f.ip, addedAt: now, online: false })
    changed = true
  }
  if (changed) {
    await saveDevices($, next)
    void probeDevices($)
  }
}

/** First run only: the last few ssh targets of recent transcripts. */
const seedDevices = async ($: $T) => {
  const r = await $.process.run(
    [
      'bash',
      '-c',
      'ls -tr "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | tail -4 | ' +
        "xargs -r grep -ahoE '\\b(ssh|scp|rsync)\\b[^\"]{0,160}\\b[a-z_][a-z0-9_-]*@[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+' | " +
        "grep -oE '[a-z_][a-z0-9_-]*@[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+' | tail -400",
    ],
    { timeoutMs: 20_000 },
  )
  const seen: string[] = []
  for (const line of r.stdout.split('\n').reverse()) {
    const t = line.trim()
    if (t && !seen.includes(t)) seen.push(t)
    if (seen.length >= 3) break
  }
  const now = await $.clock.now()
  return seen.map(s => {
    const [user = '', ip = ''] = s.split('@')
    return { user, ip, addedAt: now, online: false } as WbDevice
  })
}

let probing = false

const probeDevices = async ($: $T) => {
  if (probing) return
  probing = true
  try {
    const list = await read($, devicesA)
    if (!list.length) return
    const now = await $.clock.now()
    const results = await Promise.all(
      list.map(async (d): Promise<WbDevice> => {
        const r = await $.process.run(
          [
            'ssh',
            '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=3',
            '-o', 'StrictHostKeyChecking=accept-new',
            `${d.user}@${d.ip}`,
            PROBE,
          ],
          { timeoutMs: 10_000 },
        )
        if (r.exitCode === 0) {
          const [host = '', temp = '-', thr = '-', model = '-'] = r.stdout.split('\n').map(s => s.trim())
          const milli = Number(temp)
          const t = thr.match(/0x([0-9a-f]+)/i)
          return {
            ...d,
            hostname: host || d.hostname,
            model: model !== '-' ? model : d.model,
            online: true,
            pingable: true,
            lastSeen: now,
            lastChecked: now,
            tempC: Number.isFinite(milli) && temp !== '-' ? milli / 1000 : undefined,
            throttled: t ? parseInt(t[1] ?? '0', 16) : undefined,
          }
        }
        const p = await $.process.run(['ping', '-c', '1', '-W', '1', d.ip], { timeoutMs: 4000 })
        return { ...d, online: false, pingable: p.exitCode === 0, lastChecked: now, tempC: undefined, throttled: undefined }
      }),
    )
    // One row per board: an IP a board answered on supersedes its older IPs.
    const byHost = new Map<string, WbDevice>()
    const loose: WbDevice[] = []
    for (const d of results) {
      if (!d.hostname) {
        loose.push(d)
        continue
      }
      const prev = byHost.get(d.hostname)
      if (!prev || (d.lastSeen ?? 0) > (prev.lastSeen ?? 0)) byHost.set(d.hostname, d)
    }
    const known = new Set([...byHost.values()].map(d => d.ip))
    // An IP that never answered is forgotten after a week.
    const kept = loose.filter(d => !known.has(d.ip) && now - d.addedAt < 7 * 86_400_000)
    await saveDevices($, [...byHost.values(), ...kept])
  } finally {
    probing = false
  }
}

const THROTTLE_NOW: [number, string][] = [
  [0x1, '저전압'],
  [0x2, '클럭제한'],
  [0x4, '스로틀'],
  [0x8, '온도제한'],
]

const throttleText = (v: number | undefined) => {
  if (v === undefined) return { now: '', past: '' }
  const now = THROTTLE_NOW.filter(([b]) => v & b).map(([, n]) => n)
  const past = THROTTLE_NOW.filter(([b]) => v & (b << 16)).map(([, n]) => n)
  return { now: now.join('·'), past: past.join('·') }
}

// ---------- today's outputs ----------

const KINDS: { id: string; label: string; exts: string[] }[] = [
  { id: 'img', label: '이미지', exts: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'] },
  { id: 'md', label: 'md', exts: ['md'] },
  { id: 'doc', label: '문서', exts: ['doc', 'docx', 'hwp', 'hwpx', 'pptx', 'xlsx'] },
  { id: 'pdf', label: 'pdf', exts: ['pdf'] },
  { id: 'html', label: 'html', exts: ['html', 'htm'] },
  { id: 'data', label: '데이터', exts: ['csv', 'json', 'txt', 'log', 'yaml', 'yml'] },
]

const kindOf = (path: string) => {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return KINDS.find(k => k.exts.includes(ext))?.id ?? 'other'
}

const refreshFiles = async ($: $T) => {
  const r = await $.process.run(
    [
      'bash',
      '-c',
      'find "$HOME/tmp" -maxdepth 4 -type f -newermt "$(date +%F)" -printf "%T@\\t%s\\t%p\\n" 2>/dev/null | sort -rn | head -300',
    ],
    { timeoutMs: 15_000 },
  )
  const files: WbFile[] = []
  for (const line of r.stdout.split('\n')) {
    const [t, s, p] = line.split('\t')
    if (!p) continue
    files.push({ path: p, mtime: Math.round(Number(t) * 1000), size: Number(s) })
  }
  const prev = await read($, filesA)
  const same = prev.length === files.length && prev.every((f, i) => f.path === files[i]?.path && f.mtime === files[i]?.mtime)
  if (!same) await update($, filesA, () => files)
}

const openInWindows = async ($: $T, path: string) => {
  await $.process.run(['bash', '-c', 'explorer.exe "$(wslpath -w "$1")"', '_', path], { timeoutMs: 10_000 })
}

// ---------- registration ----------

let home = ''

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wb',
      description: '작업대 pane 열기 (/wb sum: 세션 전체 정밀 요약, /wb close: 닫기)',
      argumentHint: '[sum|close]',
    })

    home = (await $.env.get('HOME')) ?? ''
    // A reload mid-summary never reaches summarize's finally; the flag would stick.
    await update($, summaryBusyA, () => false)

    const tz = await $.process.run(['date', '+%z'], { timeoutMs: 3000 })
    const m = tz.stdout.trim().match(/^([+-])(\d\d)(\d\d)$/)
    if (m) {
      const sign = m[1] === '-' ? -1 : 1
      await update($, tzA, () => sign * (Number(m[2]) * 60 + Number(m[3])))
    }

    await setUsage($, await $.session.usage())
    const model = await $.session.model()
    await update($, modelA, cur => ({ model, effort: cur?.model === model ? cur.effort : undefined }))

    if ((await read($, devicesA)).length === 0) {
      const stored = (await $.store.get(DEVICE_STORE)) as WbDevice[] | undefined
      const list = stored?.length ? stored : await seedDevices($)
      await update($, devicesA, () => list)
    }
    const kinds = (await $.store.get('fileKinds')) as string[] | undefined
    if (kinds) await update($, fileKindsA, () => kinds)

    void refreshCost($)
    void probeDevices($)
    void refreshFiles($)
    $.clock.every(COST_EVERY_MS, () => void refreshCost($))
    $.clock.every(DEVICE_EVERY_MS, () => void probeDevices($))
    $.clock.every(FILES_EVERY_MS, () => void refreshFiles($))
    $.clock.every(5000, () => {
      void (async () => {
        const live = await read($, liveA)
        const tasks = await read($, tasksA)
        const hasRunning = tasks.some(t => t.status === 'running')
        if (hasRunning) await pollTails($)
        if (live.isRunning || hasRunning) await update($, tickA, n => n + 1)
      })()
    })
    let sinceStep = 0
    let shown = ''
    let color = BODY_GRAY
    let colorAge = 0
    let wasRunning = false
    const TICK = 80
    $.clock.every(TICK, () => {
      void (async () => {
        const live = await read($, liveA)
        // The colour needs four reads; once every half second is plenty.
        if (colorAge <= 0 || live.isRunning !== wasRunning) {
          const ctx = (await read($, usageA))?.ctxPercent
          const state = taxiStateOf(live, await read($, meterA), await read($, tasksA), ctx, await $.clock.now())
          color = bodyColor(state, ctx)
          colorAge = 6
        }
        colorAge--
        wasRunning = live.isRunning
        if (live.isRunning) {
          sinceStep += TICK
          if (sinceStep >= stepInterval(liveTokRate())) {
            sinceStep = 0
            carStep++
          }
        }
        const key = `${live.isRunning ? carStep : 'parked'}:${color}`
        if (key === shown) return
        shown = key
        const r = toRasterPalette(taxiCar(carStep, live.isRunning), carPalette(color), LCD_BG)
        await $.ui.blit({ requestId: PANE, key: 'car', cells: r.cells }).catch(() => undefined)
      })()
    })
    // Relative times ("3분 전") move even while nothing else does.
    $.clock.every(60_000, () => void update($, tickA, n => n + 1))

    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'wb' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return {}
    }
    await $.ui.open({ id: PANE, title: TITLE })
    if (arg === 'sum') void summarize($, 'fork')
    return {}
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, liveA, () => ({ isRunning: true, startedAt: now, tools: 0, lastAction: '' }))
    await update($, meterA, m => ({ ...m, rideStartUsd: m.sessionUsd ?? 0, lastRide: undefined }))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    if (e.agentId === undefined) {
      const action = describeCall(args)
      await update($, liveA, l => ({ ...l, tools: l.tools + 1, lastAction: action }))
    }
    const ran = await next(e)
    try {
      if (e.tool === 'Bash' && typeof args.command === 'string') void learnDevices($, args.command)
      if (ran.deny === undefined && !ran.isError) {
        const result = (ran.result ?? {}) as Record<string, unknown>
        const now = await $.clock.now()
        if (e.tool === 'Bash' && typeof result.backgroundTaskId === 'string') {
          const id = result.backgroundTaskId
          const outputPath = ran.text?.match(/written to: (\S+?\.output)/)?.[1]
          const label = clip(describeCall(args), 60)
          await upsertTask($, id, t => t ?? { id, label, kind: 'bash', startedAt: now, status: 'running', tail: '', outputPath })
        } else if (e.tool === 'Monitor' && typeof result.taskId === 'string') {
          const id = result.taskId
          const label = clip(String(args.description ?? 'Monitor'), 60)
          await upsertTask($, id, t => t ?? { id, label, kind: 'monitor', startedAt: now, status: 'running', tail: '' })
        } else if (e.tool === 'TaskStop') {
          const id = String(args.task_id ?? args.shell_id ?? '')
          if (id) {
            await upsertTask($, id, t => (t && t.status === 'running' ? { ...t, status: 'killed', endedAt: now } : t))
          }
        }
      }
    } catch {
      // Tracking is best effort; the call's own result is never touched.
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    try {
      const text = textOf(e.message.content)
      if (text.includes('<task-notification>')) void onNotifications($, text)
    } catch {
      // ignore
    }
    return stored
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      await update($, liveA, l => ({ ...l, isRunning: false }))
      const endedAt = await $.clock.now()
      await update($, meterA, m => ({
        ...m,
        lastRide: { usd: Math.max(0, (m.sessionUsd ?? 0) - (m.rideStartUsd ?? m.sessionUsd ?? 0)), endedAt },
        rideStartUsd: undefined,
      }))
      // "지불" shows for a while, then the meter goes back to "빈차".
      $.clock.after(PAY_SHOW_MS + 500, () => void update($, tickA, n => n + 1))
      const live = await read($, liveA)
      const worth = live.tools > 0 || e.answer.length > 200
      if (worth && !e.isAborted && (await read($, autoSummaryA))) {
        $.clock.after(50, () => void summarize($, 'auto'))
      }
      if ((await $.clock.now()) - costAt > COST_AFTER_TURN_MIN_MS) $.clock.after(100, () => void refreshCost($))
      $.clock.after(200, () => void refreshFiles($))
    }
    return done
  })

  // The model and effort each request actually goes out with (/model, /effort included).
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const effort = e.effort === undefined ? undefined : String(e.effort)
      const cur = await read($, modelA)
      if (!cur || cur.model !== e.model || cur.effort !== effort) {
        await update($, modelA, () => ({ model: e.model, effort }))
      }
    }
    if (e.agentId !== undefined) return yield* next(e)
    const stream = next(e)
    let first = 0
    for await (const chunk of stream) {
      if (!first) first = Date.now()
      if (chunk.kind === 'text' || chunk.kind === 'thinking') noteStreamed(chunk.text.length)
      else if (chunk.kind === 'input') noteStreamed(chunk.json.length)
      yield chunk
    }
    const res = await stream.result
    const out = res.usage?.output_tokens ?? 0
    const secs = first ? (Date.now() - first) / 1000 : 0
    if (out >= 20 && secs >= 0.5) {
      const tps = out / secs
      await update($, meterA, m => ({ ...m, tokPerSec: tps }))
    }
    return res
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await setUsage($, e)
    return r
  })

  // ---------- drawing ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)

    const W = Math.max(24, e.props.bodyColumns)
    const R = Math.max(16, e.props.scroll.bodyRows)
    await read($, tickA)
    const now = await $.clock.now()

    const card = await read($, summaryA)
    const busy = await read($, summaryBusyA)
    const sumErr = await read($, summaryErrorA)
    const auto = await read($, autoSummaryA)
    const live = await read($, liveA)
    const tasks = await read($, tasksA)
    const usage = await read($, usageA)
    const cost = await read($, costA)
    const model = await read($, modelA)
    const meter = await read($, meterA)
    const devices = await read($, devicesA)
    const files = await read($, filesA)
    const kinds = await read($, fileKindsA)
    const tz = await read($, tzA)

    let used = 0
    const rows: RenderChildren[] = []
    const line = (node: RenderChildren, n = 1) => {
      rows.push(node)
      used += n
    }
    const rule = (title: string, right?: RenderChildren) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">
          {'▍' + title}
        </Text>
        {right ?? <Text> </Text>}
      </Box>
    )
    const gap = () => line(<Text> </Text>)

    // --- 0. 클로드·택시: 모델 / 미터 / 한도 (맨 위) ---
    const C = {
      panel: '#141414',
      edge: '#3a3a3a',
      gold: '#e8c547',
      white: '#f2f2f2',
      blue: '#7aa2ff',
      lime: '#b6e35a',
      purple: '#c58cff',
      purpleDim: '#4a3566',
      gray: '#8a8a8a',
      red: '#ff6b6b',
    }
    const inner = W - 4
    // A ccusage run made before the session reported any spend counted none of it.
    const sinceCcusage = Math.max(0, (meter.sessionUsd ?? 0) - (meter.baseSessionUsd ?? 0))
    const todayUsd = cost ? cost.today + sinceCcusage : (meter.sessionUsd ?? 0)
    const fare = groupThousands(todayUsd * KRW_PER_USD)
    const digits = textBitmap(fare)
    const sideW = 3 // " 원"
    const tall = bitmapWidth(digits) + sideW <= inner
    const withCar = tall && CAR_WIDTH + 2 + bitmapWidth(digits) + sideW <= inner
    const digitRaster = toRaster(tall ? tallBitmap(digits) : digits, DIGIT_FG, LCD_BG)
    const ctxPct = usage?.ctxPercent
    const taxi = taxiStateOf(live, meter, tasks, ctxPct, now)
    const carRaster = toRasterPalette(taxiCar(carStep, live.isRunning), carPalette(bodyColor(taxi, ctxPct)), LCD_BG)
    // The chips stretch as far as the meter does (car, digits, 원).
    const meterW = Math.min(inner, (withCar ? CAR_WIDTH + 2 : 0) + bitmapWidth(digits) + sideW)
    const ui = $.ui.resolve(e)
    const Raster = 'Raster' in ui ? ui.Raster : undefined

    const meterRows: RenderChildren[] = []
    let meterUsed = 2 // the frame's top and bottom
    const mline = (node: RenderChildren, n = 1) => {
      meterRows.push(node)
      meterUsed += n
    }

    mline(
      <Box key="t-head" flexDirection="row" columnGap={1}>
        <Text bold color={C.gold}>클로드·택시</Text>
        {model ? <Text bold color={C.white}>{modelName(model.model)}</Text> : null}
        {model?.effort ? <Text color={C.blue}>{model.effort}</Text> : null}
        {meter.tokPerSec !== undefined ? <Text color={C.lime}>{`${meter.tokPerSec.toFixed(1)} tok/s`}</Text> : null}
      </Box>,
    )

    if (Raster) {
      mline(
        <Box key="t-meter" flexDirection="row">
          {withCar ? <Raster key="car" {...carRaster} /> : null}
          {withCar ? <Text>{'  '}</Text> : null}
          <Raster key="fare" {...digitRaster} />
          <Box flexDirection="column" justifyContent="flex-end">
            <Text bold color={C.white}>{' 원'}</Text>
          </Box>
        </Box>,
        digitRaster.rows,
      )
    } else {
      mline(<Text bold color={C.white}>{`₩${fare}`}</Text>)
    }

    /** A bar with its percentage written across the middle of it. */
    const overlayBar = (key: string, pct: number, label: string, width: number, fill: string, empty: string) => {
      const cells = Array<string>(width).fill(' ')
      const start = Math.max(0, Math.floor((width - label.length) / 2))
      for (let i = 0; i < label.length && start + i < width; i++) cells[start + i] = label[i] ?? ' '
      const f = Math.min(width, Math.max(0, Math.round((pct / 100) * width)))
      const lit = cells.slice(0, f).join('')
      const dark = cells.slice(f).join('')
      return [
        lit ? (
          <Text key={`${key}-a`} bold color="#ffffff" backgroundColor={fill}>
            {lit}
          </Text>
        ) : null,
        dark ? (
          <Text key={`${key}-b`} bold color="#ffffff" backgroundColor={empty}>
            {dark}
          </Text>
        ) : null,
      ]
    }
    {
      const five = usage?.limits.find(l => l.kind === 'five_hour')
      const week = usage?.limits.find(l => l.kind === 'seven_day')
      const extra = usage?.limits.filter(l => l !== five && l !== week) ?? []
      const hot = (p: number) => p >= 85
      const bars = 1 + (five ? 1 : 0) + (week ? 1 : 0)
      // labels: "context " + " 5H " + " 7D "
      const bw = Math.max(6, Math.floor((inner - 8 - 4 * (bars - 1)) / bars))
      /** "62%(2h10m)", or just "62%" where the bar is too short for both. */
      const limitText = (l: WbLimit) => {
        const left = fmtLeft(l.resetsAt, now)
        const full = `${Math.round(l.percentUsed)}%${left}`
        return full.length <= bw ? full : `${Math.round(l.percentUsed)}%`
      }
      mline(
        <Box key="t-limits" flexDirection="row">
          <Text color={C.lime}>{'context '}</Text>
          {ctxPct !== undefined
            ? overlayBar('ctx', ctxPct, `${ctxPct}%`, bw, hot(ctxPct) ? '#b83a3a' : '#5f8a22', '#26331a')
            : <Text color={C.gray}>{'--'.padEnd(bw)}</Text>}
          {five ? <Text color={hot(five.percentUsed) ? C.red : C.purple}>{' 5H '}</Text> : null}
          {five ? overlayBar('five', five.percentUsed, limitText(five), bw, hot(five.percentUsed) ? '#b83a3a' : '#7d55b8', '#33264a') : null}
          {week ? <Text color={hot(week.percentUsed) ? C.red : C.blue}>{' 7D '}</Text> : null}
          {week ? overlayBar('week', week.percentUsed, limitText(week), bw, hot(week.percentUsed) ? '#b83a3a' : '#3f63b8', '#1f2a4a') : null}
        </Box>,
      )
      if (extra.length) {
        mline(
          <Text color={C.gray} wrap="truncate-end">
            {extra.map(l => `${limitLabel(l.kind)} ${Math.round(l.percentUsed)}% ${fmtLeft(l.resetsAt, now)}`).join(' │ ')}
          </Text>,
        )
      }
    }

    // [name, lit background, lit text, unlit background, unlit text]: each its own hue, lit = brighter
    const CHIPS: [string, string, string, string, string][] = [
      ['빈차', '#b8b8b8', '#111111', '#4a4a4a', '#c8c8c8'],
      ['주행', '#c3c3ff', '#14143a', '#45457e', '#c9c9f0'],
      ['할증', '#ff7f9f', '#2a0a12', '#7e3549', '#f0c2cd'],
      ['복합', '#f0c43a', '#1e1800', '#73601e', '#efe0a8'],
      ['지불', '#7fd36b', '#0c1f08', '#2f6427', '#c4e8ba'],
    ]
    const rideUsd = live.isRunning
      ? Math.max(0, (meter.sessionUsd ?? 0) - (meter.rideStartUsd ?? meter.sessionUsd ?? 0))
      : (meter.lastRide?.usd ?? 0)
    mline(
      <Box key="t-chips" flexDirection="row" columnGap={1}>
        {CHIPS.map(([name, litBg, litFg, offBg, offFg]) => {
          const cw = Math.max(6, Math.floor((meterW - (CHIPS.length - 1)) / CHIPS.length))
          const padL = Math.floor((cw - 4) / 2)
          const label = ' '.repeat(padL) + name + ' '.repeat(cw - 4 - padL)
          return name === taxi ? (
            <Text key={`chip-${name}`} bold backgroundColor={litBg} color={litFg}>{label}</Text>
          ) : (
            <Text key={`chip-${name}`} backgroundColor={offBg} color={offFg}>{label}</Text>
          )
        })}
      </Box>,
    )
    /** "$18.23 (₩25,522)": dollars first, won beside them, both in yellow. */
    const money = (usdAmount: number) => `${usd(usdAmount)} (₩${groupThousands(usdAmount * KRW_PER_USD)})`
    const fixed = (key: string, node: RenderChildren) => (
      <Box key={key} flexShrink={0}>
        {node}
      </Box>
    )
    mline(
      <Box key="t-money" flexDirection="row">
        {taxi !== '빈차'
          ? fixed(
              'm-ride',
              <Text>
                <Text color={C.gray}>{taxi === '지불' ? '요금 ' : '이번 주행 '}</Text>
                <Text color={C.gold}>{money(rideUsd)}</Text>
                <Text color={C.gray}>{' · '}</Text>
              </Text>,
            )
          : null}
        {cost
          ? fixed(
              'm-sum',
              <Text>
                <Text color={C.gray}>{'오늘 '}</Text>
                <Text color={C.gold}>{money(todayUsd)}</Text>
                <Text color={C.gray}>{` · ${cost.monthStart}~ `}</Text>
                <Text color={C.gold}>{money(cost.month)}</Text>
              </Text>,
            )
          : null}
        <Text color={C.gray} wrap="truncate-end">
          {cost ? ` · ccusage ${fmtAgo(now - cost.updatedAt)}${cost.error ? ' 실패' : ''}` : 'ccusage 계산 중…'}
        </Text>
      </Box>,
    )

    line(
      <Box
        key="taxi"
        flexDirection="column"
        borderStyle="round"
        borderColor={C.edge}
        backgroundColor={C.panel}
        paddingX={1}
      >
        {meterRows}
      </Box>,
      meterUsed,
    )

    // --- 1. 작업: 요약 + 진행 + 백그라운드 작업 ---
    gap()
    line(
      rule(
        '작업',
        <Box flexDirection="row" gap={1}>
          <Button key="sum-refresh" plain dimColor label={busy ? '…' : '↻'} onPress={() => void summarize($, 'auto')} />
          <Button key="sum-fork" plain dimColor label="정밀" onPress={() => void summarize($, 'fork')} />
          <Button
            key="sum-auto"
            plain
            dimColor
            label={auto ? '자동:켬' : '자동:끔'}
            onPress={() => void update($, autoSummaryA, v => !v)}
          />
        </Box>,
      ),
    )
    if (card) {
      if (card.goal) line(<Text wrap="wrap">{'🎯 ' + card.goal}</Text>, Math.ceil((card.goal.length * 2 + 3) / W))
      for (const d of card.done) line(<Text dimColor wrap="truncate-end">{'✓ ' + d}</Text>)
      if (card.now) line(<Text color="suggestion" wrap="truncate-end">{'▶ ' + card.now}</Text>)
      if (card.next) line(<Text wrap="truncate-end">{'→ ' + card.next}</Text>)
      line(
        <Text dimColor wrap="truncate-end">
          {`  ${fmtAgo(now - card.updatedAt)} · ${card.source === 'fork' ? '정밀' : 'haiku'}`}
        </Text>,
      )
    } else {
      line(<Text dimColor>{busy ? '요약 중…' : '아직 요약 없음 — 턴이 끝나면 자동 생성 ([정밀] = 세션 전체)'}</Text>)
    }
    if (sumErr && !busy) line(<Text color="error" wrap="truncate-end">{'요약 실패: ' + sumErr}</Text>)

    if (live.isRunning) {
      line(
        <Text color="warning" wrap="truncate-end">
          {`● 실행 중 ${fmtDur(now - live.startedAt)} · 도구 ${live.tools}${live.lastAction ? ' · ' + live.lastAction : ''}`}
        </Text>,
      )
    }

    const running = tasks.filter(t => t.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
    const recent = tasks
      .filter(t => t.status !== 'running' && now - (t.endedAt ?? 0) < SHOW_FINISHED_MS)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, 3)
    if (running.length || recent.length) {
      line(<Text dimColor>{`백그라운드 작업 ${running.length}개 실행 중`}</Text>)
    }
    for (const t of running) {
      line(
        <Text color="warning" wrap="truncate-end">
          {`${t.kind === 'monitor' ? '◉' : '●'} ${t.label}  ${fmtDur(now - t.startedAt)}`}
        </Text>,
      )
      const pct = t.tail ? progressOf(t.tail) : undefined
      if (pct !== undefined) {
        const bw = Math.min(20, Math.max(6, Math.floor(W / 3)))
        line(
          <Box key={`p-${t.id}`} flexDirection="row">
            <Text>{'  '}</Text>
            <Text color="suggestion">{bar(pct, bw)}</Text>
            <Text>{` ${String(Math.round(pct)).padStart(3)}% `}</Text>
            <Text dimColor wrap="truncate-start">
              {t.tail}
            </Text>
          </Box>,
        )
      } else if (t.tail) {
        line(<Text dimColor wrap="truncate-start">{'  ' + t.tail}</Text>)
      }
    }
    for (const t of recent) {
      const mark = t.status === 'completed' ? '✓' : t.status === 'failed' ? '✗' : '■'
      line(
        <Text dimColor={t.status === 'completed'} color={t.status === 'completed' ? undefined : 'error'} wrap="truncate-end">
          {`${mark} ${t.label}  ${fmtDur((t.endedAt ?? now) - t.startedAt)} · ${fmtAgo(now - (t.endedAt ?? now))}`}
        </Text>,
      )
    }

    // --- 3. 장치 ---
    gap()
    line(rule('장치', <Text dimColor>{devices.length ? '30초마다 확인' : ''}</Text>))
    const named = devices.filter(d => d.hostname)
    const unnamed = devices.filter(d => !d.hostname)
    const sortedDevices = [...named].sort(
      (a, b) => Number(b.online) - Number(a.online) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
    )
    if (!devices.length) line(<Text dimColor>ssh/scp 로 접속한 장치가 생기면 여기에 표시</Text>)
    for (const d of sortedDevices) {
      const name = [boardOf(d.model), d.hostname].filter(Boolean).join(' ')
      if (d.online) {
        const th = throttleText(d.throttled)
        const temp = d.tempC
        const isHot = temp !== undefined && temp >= 65
        line(
          <Box key={`d-${d.ip}`} flexDirection="row">
            <Text color="success">{'● '}</Text>
            <Text wrap="truncate-end">
              {`${name} ${d.ip}${temp !== undefined && !isHot ? ` ${temp.toFixed(1)}°C` : ''}`}
            </Text>
          </Box>,
        )
        // Only trouble gets a line: heat, throttling now, or throttling since boot.
        const issues = [
          isHot ? `${temp.toFixed(1)}°C` : '',
          th.now ? `⚠ ${th.now}` : '',
        ].filter(Boolean)
        if (issues.length) {
          line(
            <Text color={th.now || (temp ?? 0) >= 80 ? 'error' : 'warning'} wrap="truncate-end">
              {'   ' + issues.join(' · ')}
            </Text>,
          )
        }
        if (th.past) line(<Text dimColor wrap="truncate-end">{`   부팅 후 발생: ${th.past}`}</Text>)
      } else {
        line(
          <Box key={`d-${d.ip}`} flexDirection="row">
            <Text dimColor>{'○ '}</Text>
            <Text dimColor wrap="truncate-end">
              {`${name} ${d.ip} · ${d.lastSeen ? fmtAgo(now - d.lastSeen) : '?'} · ${
                d.pingable === undefined ? '확인 중' : d.pingable ? 'ping만 응답' : '응답 없음'
              }`}
            </Text>
          </Box>,
        )
      }
    }
    if (unnamed.length) {
      line(
        <Text dimColor wrap="truncate-end">
          {`○ 미확인 IP: ${unnamed.map(d => `${d.ip}${d.pingable ? '(ping)' : ''}`).join(', ')}`}
        </Text>,
      )
    }

    // --- 4. 오늘 결과물 ---
    gap()
    const shown = files.filter(f => kinds.includes(kindOf(f.path)))
    line(rule('오늘 결과물', <Text dimColor>{`${shown.length}/${files.length} · ~/tmp`}</Text>))
    line(
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {KINDS.map(k => {
          const isOn = kinds.includes(k.id)
          return (
            <Button
              key={`k-${k.id}`}
              plain
              dimColor={!isOn}
              label={(isOn ? '[x]' : '[ ]') + k.label}
              onPress={() =>
                void (async () => {
                  const nextKinds = await update($, fileKindsA, ks =>
                    ks.includes(k.id) ? ks.filter(x => x !== k.id) : [...ks, k.id],
                  )
                  await $.store.set('fileKinds', nextKinds)
                })()
              }
            />
          )
        })}
      </Box>,
    )
    const tmpRoot = home ? `${home}/tmp/` : '/tmp/'
    const room = Math.max(3, R - used - 1)
    if (!shown.length) line(<Text dimColor>오늘 만든 파일 없음</Text>)
    for (const f of shown.slice(0, room)) {
      const rel = f.path.startsWith(tmpRoot) ? f.path.slice(tmpRoot.length) : f.path
      const label = `${local(f.mtime, tz).hm}  ${rel}`
      rows.push(
        <Button
          key={`f-${f.path}`}
          plain
          label={clip(label, W - 1)}
          onPress={() => void openInWindows($, f.path)}
        />,
      )
    }
    if (shown.length > room) rows.push(<Text dimColor>{`  … ${shown.length - room}개 더`}</Text>)

    return (
      <Box flexDirection="column" width={W}>
        {rows}
      </Box>
    )
  })
}
