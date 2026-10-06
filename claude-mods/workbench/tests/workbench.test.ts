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

const world = (on: any, opts: { ssh?: boolean } = {}) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  const calls: string[][] = []
  on('process.run', ($: any, e: any) => {
    const argv: string[] = [...e.argv]
    calls.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const fail = { value: { exitCode: 255, stdout: '', stderr: 'no route', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'date') return ok('+0900\n')
    if (argv[0] === 'npx') return ok(CCUSAGE_JSON)
    if (argv[0] === 'ssh') {
      return opts.ssh
        ? ok('pi-cm5\n52300\nthrottled=0x50000\nRaspberry Pi Compute Module 5 Rev 1.0\n')
        : fail
    }
    if (argv[0] === 'ping') return fail
    if (argv[0] === 'bash' && argv[2]?.includes('.jsonl')) return ok('pi@192.0.2.5\n')
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
  for (const title of ['▍작업', '▍사용량', '▍장치', '▍오늘 결과물']) {
    expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
  }
  await ui.unmount()
})

test('session start fills cost, gauges, files and devices', async ($: any, on: any) => {
  const { calls, clock } = world(on, { ssh: true })
  on('session.start', ($2: any, e: any) => ({ cwd: e.cwd }))
  await start($)
  await clock.settle()
  const ui = await mountPane($)
  expect(calls.some(a => a[0] === 'npx' && a.includes('--since') && a.includes('20261001'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /\$16\.73/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$43\.77/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / 62% 124k\/200k/ })).toBeDefined()
  // default filter: images, md, docs — the csv is hidden
  expect(await ui.find({ type: 'Button', text: /plot\.png/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /notes\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /data\.csv/ })).toBeUndefined()
  await ui.press({ key: 'k-data' })
  expect(await ui.find({ type: 'Button', text: /data\.csv/ })).toBeDefined()
  // the seeded board answered: name, temperature, sticky throttle bits
  expect(await ui.find({ type: 'Text', text: 'CM5 pi-cm5 192.0.2.5 52.3°C' })).toBeDefined()
  // no current throttling: nothing said about it, only the since-boot record
  expect(await ui.find({ type: 'Text', text: /스로틀 없음|⚠/ })).toBeUndefined()
  // limits show only the time left, in parentheses
  expect(await ui.find({ type: 'Text', text: /남음|↻/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5 1M' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /부팅 후 발생: 저전압·스로틀/ })).toBeDefined()
  await ui.unmount()
})

test('an unreachable device shows its last IP', async ($: any, on: any) => {
  const { clock } = world(on, { ssh: false })
  on('session.start', ($2: any, e: any) => ({ cwd: e.cwd }))
  await start($)
  await clock.settle()
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /미확인 IP: 192\.0\.2\.5/ })).toBeDefined()
  await ui.unmount()
})

test('the summary is made from the transcript', async ($: any, on: any) => {
  mock.clock(on, { now: NOW })
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
  on('model.complete', ($2: any, e: any) => {
    sent = e.prompt
    return {
      value: {
        isAnswered: true,
        text: '{"goal":"작업대 mod 개선","done":["사용량 표시 수정"],"now":"요약 경로 수정","next":"실사용 확인"}',
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
