import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = {
  title: '작업대',
  isFocused: false,
  bodyColumns: 64,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 50 },
  view: {},
} as const

const mountPane = ($: any) =>
  $.ui.mount({ plugin: 'workbench', surface: 'terminal', component: 'Pane', requestId: 'workbench', props: PANE_PROPS })

// 2026-10-06 12:00 KST
const NOW = Date.parse('2026-10-06T03:00:00Z')

const CCUSAGE_JSON = JSON.stringify({
  daily: [
    { period: '2026-10-01', totalCost: 27.04, totalTokens: 58_996_034 },
    { period: '2026-10-06', totalCost: 16.73, totalTokens: 19_400_874 },
  ],
  totals: { totalCost: 43.77, totalTokens: 78_396_908 },
})

const world = (on: any) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.id', () => ({ value: 'sess-test' }))
  mock.env(on, { HOME: '/home/u' })
  const calls: string[][] = []
  on('process.run', ($: any, e: any) => {
    const argv: string[] = [...e.argv]
    calls.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'date') return ok('+0900\n')
    if (argv[0] === 'npx') return ok(CCUSAGE_JSON)
    if (argv[0] === 'bash' && argv[2]?.includes('find')) {
      return ok(
        `${NOW / 1000 - 60}\t100\t/home/u/tmp/2026-10-06/plot.png\n` +
          `${NOW / 1000 - 120}\t100\t/home/u/tmp/2026-10-06/data.csv\n` +
          `${NOW / 1000 - 180}\t100\t/home/u/tmp/2026-10-06/notes.md\n`,
      )
    }
    return ok('')
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 124_000, window: 200_000, percent: 62 }, rateLimits: [{ kind: 'five_hour', percentUsed: 23 }] },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { calls, clock }
}

const start = ($: any) => $.session.start({ source: 'startup', cwd: '/w' })

test('pane draws the four sections', async ($: any, on: any) => {
  mock.clock(on, { now: NOW })
  const ui = await mountPane($)
  for (const title of ['▍사용량', '▍작업', '▍할일', '▍오늘 결과물']) {
    expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
  }
  await ui.unmount()
})

test('session start fills cost, gauges and files', async ($: any, on: any) => {
  const { calls, clock } = world(on)
  on('session.start', ($2: any, e: any) => ({ cwd: e.cwd }))
  await start($)
  await clock.settle()
  const ui = await mountPane($)
  expect(calls.some(a => a[0] === 'npx' && a.includes('--since') && a.includes('20261001'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /\$16\.73/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$43\.77/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /62%/ })).toBeDefined()
  expect(await ui.find({ key: 'g-ctx' })).toBeDefined()
  // the usage table sits first in the pane, above 작업
  const order = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
  expect(order.indexOf('▍사용량')).toBeLessThan(order.indexOf('▍작업'))
  // default filter: images, md, docs — the csv is hidden
  expect(await ui.find({ type: 'Button', text: /plot\.png/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /notes\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /data\.csv/ })).toBeUndefined()
  await ui.press({ key: 'k-data' })
  expect(await ui.find({ type: 'Button', text: /data\.csv/ })).toBeDefined()
  // nothing probes boards any more
  expect(calls.some(a => a[0] === 'ssh' || a[0] === 'ping')).toBe(false)
  // limits show only the time left, in parentheses
  expect(await ui.find({ type: 'Text', text: /남음|↻/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5 1M' })).toBeDefined()
  await ui.unmount()
})

test('the summary is made from the transcript', async ($: any, on: any) => {
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'sess-test' }))
  // one store hook of the test's own: it records the todos and answers nothing for every key
  let stored: any[] = []
  const mem: Record<string, unknown> = {}
  on('store.get', ($2: any, e: any) => ({ value: mem[e.key] }))
  on('store.set', ($2: any, e: any) => {
    mem[e.key] = e.value
    if (String(e.key).startsWith('todos:')) stored = e.value
    return { value: undefined }
  })
  let sent = ''
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '작업대 mod 요약을 고쳐줘', toolUses: [] },
      {
        role: 'assistant',
        text: '원인은 리로드였습니다.',
        toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'ls', description: 'List mod files' } }],
      },
      { role: 'user', text: '<task-notification>x</task-notification>', toolUses: [] },
    ],
  }))
  // one model hook, registered before the first use of $; `reply` is what it answers at the time
  let reply =
    '{"goal":"작업대 mod 개선","now":"요약 경로 수정","done":["사용량 표시 수정"],' +
    '"todos":[{"id":"","text":"장치 섹션 제거","state":"done"},{"id":"","text":"할일 섹션 추가","state":"doing"},{"id":"","text":"실사용 확인","state":"todo"}]}'
  on('model.complete', ($2: any, e: any) => {
    sent = e.prompt
    return {
      value: {
        isAnswered: true,
        text: reply,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  })
  const ui = await mountPane($)
  await ui.press({ key: 'sum-refresh' })
  expect(sent).toContain('작업대 mod 요약을 고쳐줘')
  expect(sent).toContain('List mod files')
  expect(sent).not.toContain('task-notification')
  expect(await ui.find({ type: 'Text', text: '🎯 작업대 mod 개선' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▶ 요약 경로 수정' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  ✓ 사용량 표시 수정' })).toBeDefined()
  // the todos came with the card: counted, drawn in order, kept in the store
  expect(await ui.find({ type: 'Text', text: '1/3' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '[x] 장치 섹션 제거' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '[▶] 할일 섹션 추가' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '[ ] 실사용 확인' })).toBeDefined()
  expect(stored.length).toBe(3)
  // a click moves an item on and pins it; the next summary may not move it back
  const id = stored[2].id
  await ui.press({ key: `todo-${id}` })
  expect(await ui.find({ type: 'Button', text: '[▶] 실사용 확인' })).toBeDefined()
  sent = ''
  reply = `{"goal":"작업대 mod 개선","now":"테스트","done":[],"todos":[{"id":"${id}","text":"실사용 확인","state":"todo"}]}`
  await ui.press({ key: 'sum-refresh' })
  expect(sent).toContain('[현재 할일 목록]')
  expect(sent).toContain('"manual":true')
  expect(await ui.find({ type: 'Button', text: '[▶] 실사용 확인' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /장치 섹션 제거/ })).toBeUndefined()
  // the sweep button removes finished items; × removes one
  await ui.press({ key: `todo-rm-${id}` })
  expect(await ui.find({ type: 'Button', text: /실사용 확인/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /목표가 정해지면/ })).toBeDefined()
  await ui.unmount()
})

test('an empty transcript says so instead of asking the model', async ($: any, on: any) => {
  mock.clock(on, { now: NOW })
  let asked = false
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => {
    asked = true
    return { value: { isAnswered: false, reason: 'empty-reply', usage: {} } }
  })
  const ui = await mountPane($)
  await ui.press({ key: 'sum-refresh' })
  expect(asked).toBe(false)
  expect(await ui.find({ type: 'Text', text: /아직 요약할 대화가 없습니다/ })).toBeDefined()
  await ui.unmount()
})

test('the session ledger moves 오늘 between ccusage runs', async ($: any, on: any) => {
  const { clock } = world(on)
  on('session.start', ($2: any, e: any) => ({ cwd: e.cwd }))
  on('session.measure', ($2: any, e: any) => ({ changed: e.changed }))
  await start($)
  await clock.settle()
  const measure = (usd: number) =>
    $.session.measure({
      context: { tokens: 150_000, window: 200_000, percent: 75 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 62, resetsAt: new Date(NOW + 2 * 3600_000).toISOString() },
        { kind: 'seven_day', percentUsed: 25 },
      ],
      cost: { usd },
      changed: ['cost'],
    })
  await measure(1.0)
  const ui = await mountPane($)
  // ccusage said $16.73 today; the session has spent $1.00 since that run counted $0
  expect((await ui.find({ key: 'c-today' }))?.text).toContain('$17.73')
  await measure(1.5)
  expect((await ui.find({ key: 'c-today' }))?.text).toContain('$18.23')
  // the limits: percentage, then the time left
  expect((await ui.find({ key: 'g-five_hour' }))?.text).toContain('62%')
  expect((await ui.find({ key: 'g-seven_day' }))?.text).toContain('25%')
  expect((await ui.find({ key: 'g-ctx' }))?.text).toContain('75%')
  await ui.unmount()
})
