import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { WbCost, WbFile, WbLimit, WbSummary, WbTask, WbTodo, WbUsage } from '../types'

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
// The session's own spend ledger: moves "오늘" between ccusage runs.
const meterA = atom({ plugin: 'workbench', key: 'meter' } as const, {})
const modelA = atom({ plugin: 'workbench', key: 'model' } as const, null)
const costA = atom({ plugin: 'workbench', key: 'cost' } as const, null)
const todosA = atom({ plugin: 'workbench', key: 'todos' } as const, [])
/** Each session keeps its own list under `todos:<session id>`; the bare `todos` key was the old shared one. */
const TODO_STORE_PREFIX = 'todos:'
const TODO_STORE_KEEP = 20
const todoStoreKey = async ($: $T) => TODO_STORE_PREFIX + (await $.session.id())
const filesA = atom({ plugin: 'workbench', key: 'files' } as const, [])
const fileKindsA = atom({ plugin: 'workbench', key: 'fileKinds' } as const, ['img', 'md', 'doc'])
const tzA = atom({ plugin: 'workbench', key: 'tzOffsetMin' } as const, 0)
const tickA = atom({ plugin: 'workbench', key: 'tick' } as const, 0)

const CCUSAGE = 'ccusage@20.0.26'
const COST_EVERY_MS = 5 * 60_000
const COST_AFTER_TURN_MIN_MS = 60_000
const FILES_EVERY_MS = 30_000
const SHOW_FINISHED_MS = 10 * 60_000
const KEEP_FINISHED = 6

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

const CARD_FORMAT =
  '{"goal":"...","now":"...","done":["..."],"todos":[{"id":"...","text":"...","state":"todo|doing|done"}]}'

const CARD_RULES =
  'goal=진행 중인 일 전반의 요약(무엇을 왜 하는지 한 줄), now=지금 하고 있는 것, ' +
  'done=최근 수행한 것 최대 4개(최신이 앞, 숫자·파일명 포함). ' +
  'todos=정해진 목표를 이루기 위한 할일 항목. 사용자가 목표나 작업을 정하면 그때 단계별 항목으로 나누고, ' +
  '목표가 없으면 빈 배열. 최대 8개, 순서는 할 순서. 기존 항목은 id 를 그대로 두고 state 만 갱신한다 ' +
  '(끝났으면 done, 하는 중이면 doing). 사용자가 취소하거나 더 이상 뜻이 없는 항목은 뺀다. ' +
  'manual 이 true 인 항목의 state 는 사용자가 직접 정한 것이니 바꾸지 않는다. 새 항목은 id 를 빈 문자열로. ' +
  '모두 한국어, 각 문장 45자 이내, 군더더기 없이 명사형으로.'

const SUMMARY_SYSTEM =
  '너는 개발 세션 옆 사이드바에 띄울 "작업" 카드와 "할일" 목록을 쓰는 요약기다. 반드시 JSON 한 개만 출력한다. ' +
  '형식: ' + CARD_FORMAT + ' . ' + CARD_RULES

const forkPrompt = (todos: readonly WbTodo[]) =>
  '이 세션 옆 사이드바에 띄울 "작업" 카드와 "할일" 목록을 만들어줘. 도구는 쓰지 말고 JSON 한 개만 출력해. ' +
  '형식: ' + CARD_FORMAT + ' . ' + CARD_RULES +
  (todos.length ? '\n[현재 할일 목록]\n' + JSON.stringify(todoRows(todos)) : '')

const todoRows = (todos: readonly WbTodo[]) =>
  todos.map(t => ({ id: t.id, text: t.text, state: t.state, ...(t.manual ? { manual: true } : {}) }))

/** What the card is made from, read from the transcript itself so a reload or resume loses nothing. */
const buildDigest = async ($: $T, prev: WbSummary | null, todos: readonly WbTodo[]): Promise<string | null> => {
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
      '[이전 카드]\n' + JSON.stringify({ goal: prev.goal, now: prev.now, done: prev.done }),
    )
  }
  if (todos.length) parts.push('[현재 할일 목록]\n' + JSON.stringify(todoRows(todos)))
  if (prompts.length) parts.push('[최근 사용자 요청]\n' + prompts.map(p => '- ' + p).join('\n'))
  if (actions.length) parts.push('[최근 도구 작업]\n' + actions.map(a => '- ' + a).join('\n'))
  if (answer) parts.push('[어시스턴트의 마지막 답변]\n' + clip(answer, 2500))
  parts.push(
    '위 개발 세션 기록으로 카드와 할일 목록을 갱신해. 이전 카드의 goal 은 주제가 바뀌지 않았으면 유지하고, ' +
      '할일은 기록에 근거가 있을 때만 state 를 바꾸거나 항목을 더해.\n' +
      '출력은 ' + CARD_FORMAT + ' 형식의 JSON 한 개뿐이다. 인사·설명·코드펜스 금지.',
  )
  return parts.join('\n\n')
}

const TODO_STATES: WbTodo['state'][] = ['todo', 'doing', 'done']
const TODO_MAX = 8

type Parsed = { card: WbSummary; todos: WbTodo[] | undefined }

/** The model's reply, checked field by field; `todos` stays undefined when the reply left them out. */
const parseSummary = (
  text: string,
  source: WbSummary['source'],
  now: number,
  prevTodos: readonly WbTodo[],
): Parsed | null => {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const o = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    const done = Array.isArray(o.done) ? o.done.map(str).filter(Boolean).slice(0, 4) : []
    const card: WbSummary = { goal: str(o.goal), done, now: str(o.now), updatedAt: now, source }
    if (!Array.isArray(o.todos)) return { card, todos: undefined }
    const byId = new Map(prevTodos.map(t => [t.id, t]))
    const todos: WbTodo[] = []
    let seq = 0
    for (const raw of o.todos) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const text = str(r.text)
      if (!text) continue
      const prev = byId.get(str(r.id))
      const asked = str(r.state) as WbTodo['state']
      const state = prev?.manual ? prev.state : TODO_STATES.includes(asked) ? asked : prev?.state ?? 'todo'
      const id = prev?.id ?? `${now.toString(36)}${(seq++).toString(36)}`
      todos.push({
        id,
        text,
        state,
        manual: prev?.manual,
        addedAt: prev?.addedAt ?? now,
        updatedAt: prev && prev.state === state && prev.text === text ? prev.updatedAt : now,
      })
      if (todos.length >= TODO_MAX) break
    }
    return { card, todos }
  } catch {
    return null
  }
}

const saveTodos = async ($: $T, todos: WbTodo[]) => {
  await update($, todosA, () => todos)
  // Kept per session, so a resume gets its own list back and other sessions never see it.
  await $.store.set(await todoStoreKey($), todos)
}

/** Drops the old shared list and every session list but the newest few. */
const pruneTodoStore = async ($: $T, keep: string) => {
  const keys = await $.store.keys()
  if (keys.includes('todos')) await $.store.delete('todos')
  const mine = keys.filter(k => k.startsWith(TODO_STORE_PREFIX) && k !== keep)
  for (const k of mine.slice(0, Math.max(0, mine.length - (TODO_STORE_KEEP - 1)))) await $.store.delete(k)
}

/** A click walks an item todo → doing → done → todo and pins it against the summarizer. */
const cycleTodo = async ($: $T, id: string) => {
  const now = await $.clock.now()
  const todos = (await read($, todosA)).map(t => {
    if (t.id !== id) return t
    const state = TODO_STATES[(TODO_STATES.indexOf(t.state) + 1) % TODO_STATES.length] ?? 'todo'
    return { ...t, state, manual: true, updatedAt: now }
  })
  await saveTodos($, todos)
}

const removeTodo = async ($: $T, id: string) => {
  await saveTodos($, (await read($, todosA)).filter(t => t.id !== id))
}

const summarize = async ($: $T, source: WbSummary['source']) => {
  if (await read($, summaryBusyA)) return
  await update($, summaryBusyA, () => true)
  try {
    const prev = await read($, summaryA)
    const prevTodos = await read($, todosA)
    const digest = source === 'fork' ? forkPrompt(prevTodos) : await buildDigest($, prev, prevTodos)
    if (digest === null) {
      await update($, summaryErrorA, () => '아직 요약할 대화가 없습니다')
      return
    }
    const r =
      source === 'fork'
        ? await $.model.fork({ prompt: digest })
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
    const parsed = parseSummary(r.text, source, await $.clock.now(), prevTodos)
    if (parsed) {
      await update($, summaryA, () => parsed.card)
      if (parsed.todos) await saveTodos($, parsed.todos)
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
    // The engine's wording for a monitor's end: '[Monitor expired after 30m …]', '[Monitor stopped …]', ….
    const monitorEnded = /\[Monitor (expired|timed out|stopped|ended|exited|killed|cancelled)/i.test(event)
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

// Marks every task still shown as running as ended (optionally only those older than `olderThanMs`).
// Used by `/wb task clear` and, on reload, to retire monitors whose end notice an older version missed.
const retireRunning = async ($: $T, olderThanMs = 0) => {
  const now = await $.clock.now()
  await update($, tasksA, list =>
    list.map((t): WbTask => (t.status === 'running' && now - t.startedAt >= olderThanMs ? { ...t, status: 'killed', endedAt: now } : t)),
  )
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

/** Opens a file with the desktop's default app (native Linux; the old WSL path went through explorer.exe). */
const openInWindows = async ($: $T, path: string) => {
  await $.process.run(['xdg-open', path], { timeoutMs: 10_000 })
}

// ---------- registration ----------

let home = ''

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wb',
      description: '작업대 pane 열기 (/wb sum: 세션 전체 정밀 요약, /wb todo clear: 할일 비우기, /wb task clear: 백그라운드 작업 목록 정리, /wb close: 닫기)',
      argumentHint: '[sum|todo clear|task clear|close]',
    })

    home = (await $.env.get('HOME')) ?? ''
    // A reload mid-summary never reaches summarize's finally; the flag would stick.
    await update($, summaryBusyA, () => false)
    // A monitor lives at most 30 min; one still 'running' past an hour is a notice this mod missed (e.g. before a reload).
    await retireRunning($, 60 * 60_000)

    const tz = await $.process.run(['date', '+%z'], { timeoutMs: 3000 })
    const m = tz.stdout.trim().match(/^([+-])(\d\d)(\d\d)$/)
    if (m) {
      const sign = m[1] === '-' ? -1 : 1
      await update($, tzA, () => sign * (Number(m[2]) * 60 + Number(m[3])))
    }

    await setUsage($, await $.session.usage())
    const model = await $.session.model()
    await update($, modelA, cur => ({ model, effort: cur?.model === model ? cur.effort : undefined }))

    const todoKey = await todoStoreKey($)
    if ((await read($, todosA)).length === 0) {
      const stored = (await $.store.get(todoKey)) as WbTodo[] | undefined
      if (stored?.length) await update($, todosA, () => stored)
    }
    void pruneTodoStore($, todoKey).catch(() => undefined)
    const kinds = (await $.store.get('fileKinds')) as string[] | undefined
    if (kinds) await update($, fileKindsA, () => kinds)

    void refreshCost($)
    void refreshFiles($)
    $.clock.every(COST_EVERY_MS, () => void refreshCost($))
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
    if (arg === 'todo clear') await saveTodos($, [])
    if (arg === 'task clear') await retireRunning($)
    return {}
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, liveA, () => ({ isRunning: true, startedAt: now, tools: 0, lastAction: '' }))
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

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, todosA, () => [])
      await update($, summaryA, () => null)
      await update($, summaryErrorA, () => '')
    }
    return next(e)
  })

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
    return yield* next(e)
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
    const todos = await read($, todosA)
    const files = await read($, filesA)
    const kinds = await read($, fileKindsA)
    const tz = await read($, tzA)

    let used = 0
    const rows: RenderChildren[] = []
    // Each section is a rounded box: its rows gather in `cur` until `end()` frames them.
    let cur: RenderChildren[] | null = null
    let curKey = ''
    const line = (node: RenderChildren, n = 1) => {
      ;(cur ?? rows).push(node)
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
    const begin = (key: string, title: string, right?: RenderChildren) => {
      cur = []
      curKey = key
      used += 2 // the frame's top and bottom
      line(rule(title, right))
    }
    const end = () => {
      if (!cur) return
      rows.push(
        <Box key={curKey} flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
          {cur}
        </Box>,
      )
      cur = null
    }
    // Columns left for text inside a framed section (border 2 + padding 2).
    const inner = W - 4

    // --- 0. 사용량: 모델 / 비용 / 한도 (맨 위) ---
    // A ccusage run made before the session reported any spend counted none of it.
    const sinceCcusage = Math.max(0, (meter.sessionUsd ?? 0) - (meter.baseSessionUsd ?? 0))
    const todayUsd = cost ? cost.today + sinceCcusage : (meter.sessionUsd ?? 0)

    begin(
      'usage',
      '사용량',
      <Text dimColor>{cost ? `ccusage ${fmtAgo(now - cost.updatedAt)}${cost.error ? ' (갱신 실패)' : ''}` : 'ccusage 계산 중…'}</Text>,
    )
    {
      const labelW = 9
      if (model) {
        line(
          <Box key="m" flexDirection="row">
            <Text>{'모델'.padEnd(labelW - 2)}</Text>
            <Text bold wrap="truncate-end">{`${modelName(model.model)}${model.effort ? ' · ' + model.effort : ''}`}</Text>
          </Box>,
        )
      }
      if (cost) {
        line(
          <Box key="c-today" flexDirection="row">
            <Text>{'오늘'.padEnd(labelW - 2)}</Text>
            <Text bold>{usd(todayUsd).padStart(9)}</Text>
            <Text dimColor>{`  ${kTokens(cost.todayTokens)}`}</Text>
          </Box>,
        )
        line(
          <Box key="c-month" flexDirection="row">
            <Text>{'이번 달'.padEnd(labelW - 3)}</Text>
            <Text bold>{usd(cost.month).padStart(9)}</Text>
            <Text dimColor>{`  ${kTokens(cost.monthTokens)}`}</Text>
          </Box>,
        )
      }
      const tailW = 22
      const barW = Math.min(24, Math.max(6, inner - labelW - tailW))
      const gauge = (label: string, pct: number | undefined, right: string, key: string) =>
        line(
          <Box key={key} flexDirection="row">
            <Text>{label.padEnd(labelW - Math.min(4, label.replace(/[ -~]/g, '').length))}</Text>
            <Text color={pct === undefined ? 'inactive' : levelColor(pct)}>{bar(pct ?? 0, barW)}</Text>
            <Text wrap="truncate-end">{` ${pct === undefined ? '--' : String(Math.round(pct)).padStart(3)}% ${right}`}</Text>
          </Box>,
        )
      if (usage) {
        for (const l of usage.limits) gauge(limitLabel(l.kind), l.percentUsed, fmtLeft(l.resetsAt, now), `g-${l.kind}`)
        gauge('컨텍스트', usage.ctxPercent, `${kTokens(usage.ctxTokens)}/${kTokens(usage.ctxWindow)}`, 'g-ctx')
      }
      end()
    }

    // --- 1. 작업: 요약 + 진행 + 백그라운드 작업 ---
    begin(
      'work',
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
    )
    if (card) {
      if (card.goal) line(<Text wrap="wrap">{'🎯 ' + card.goal}</Text>, Math.ceil((card.goal.length * 2 + 3) / inner))
      if (card.now) line(<Text color="suggestion" wrap="truncate-end">{'▶ ' + card.now}</Text>)
      if (card.done.length) line(<Text dimColor>최근 수행</Text>)
      for (const d of card.done) line(<Text dimColor wrap="truncate-end">{'  ✓ ' + d}</Text>)
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
        const bw = Math.min(20, Math.max(6, Math.floor(inner / 3)))
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

    end()

    // --- 3. 할일: 정해진 목표를 단계로 나눈 목록 (클릭 = 상태 바꾸기) ---
    const nDone = todos.filter(t => t.state === 'done').length
    begin(
      'todos',
      '할일',
      <Box flexDirection="row" gap={1}>
        {todos.length ? <Text dimColor>{`${nDone}/${todos.length}`}</Text> : null}
        {nDone ? (
          <Button
            key="todo-sweep"
            plain
            dimColor
            label="끝난것 지움"
            onPress={() => void saveTodos($, todos.filter(t => t.state !== 'done'))}
          />
        ) : null}
      </Box>,
    )
    if (!todos.length) {
      line(<Text dimColor>목표가 정해지면 할일을 항목으로 나누어 표시 (요약과 함께 갱신)</Text>)
    }
    for (const t of todos) {
      const mark = t.state === 'done' ? '[x]' : t.state === 'doing' ? '[▶]' : '[ ]'
      line(
        <Box key={`t-${t.id}`} flexDirection="row">
          <Button
            key={`todo-${t.id}`}
            plain
            dimColor={t.state === 'done'}
            label={clip(`${mark} ${t.text}`, Math.max(8, inner - 3))}
            onPress={() => void cycleTodo($, t.id)}
          />
          <Button key={`todo-rm-${t.id}`} plain dimColor label=" ×" onPress={() => void removeTodo($, t.id)} />
        </Box>,
      )
    }
    end()

    // --- 4. 오늘 결과물 ---
    const shown = files.filter(f => kinds.includes(kindOf(f.path)))
    begin('files', '오늘 결과물', <Text dimColor>{`${shown.length}/${files.length} · ~/tmp`}</Text>)
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
      line(
        <Button
          key={`f-${f.path}`}
          plain
          label={clip(label, inner - 1)}
          onPress={() => void openInWindows($, f.path)}
        />,
      )
    }
    if (shown.length > room) line(<Text dimColor>{`  … ${shown.length - room}개 더`}</Text>)
    end()

    return (
      <Box flexDirection="column" width={W}>
        {rows}
      </Box>
    )
  })
}
