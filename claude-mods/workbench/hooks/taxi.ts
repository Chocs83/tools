// Pixel drawing for the taximeter: a 5x7 digit font, a two-frame horse, and the
// half-block encoding a Raster takes (two vertical pixels per terminal cell).

export type Bitmap = string[] // rows of '#' (on) and '.' (off), all one width

const GLYPHS: Record<string, Bitmap> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  ',': ['..', '..', '..', '..', '..', '.#', '#.'],
}

/** The digits and commas of `text` side by side, one blank column between glyphs. */
export const textBitmap = (text: string): Bitmap => {
  const glyphs = [...text].map(c => GLYPHS[c]).filter((g): g is Bitmap => g !== undefined)
  const rows: string[] = []
  for (let y = 0; y < 7; y++) rows.push(glyphs.map(g => g[y] ?? '').join('.'))
  return rows
}

export const bitmapWidth = (b: Bitmap) => b[0]?.length ?? 0

// A taxi driving left, 20x10 pixels (5 terminal rows), drawn from a palette:
// Y roof sign, B body (the state colour), W windows, L headlight, K tyre,
// C hub, D the hub's turning spot, R lane dashes, S wind lines.
const CAR: Bitmap = [
  '......YYYY..........',
  '....BBBBBBBB........',
  '...BWWWBWWWWB.......',
  '..BWWWWBWWWWWB......',
  'BBBBBBBBBBBBBBBB....',
  'LBBBBBBBBBBBBBBB....',
  'BB....BBBBB....B....',
  '....................',
  '....................',
  '....................',
]
export const CAR_WIDTH = 20

// A 4x4 wheel with its corners cut round, tucked one pixel into the body so the road row runs clear under it.
const WHEEL = ['.KK.', 'KCCK', 'KCCK', '.KK.']
const WHEEL_X = [2, 11]
const WHEEL_Y = 5

// The dark spot that turns in the 2x2 hub, counter-clockwise (the car drives
// left); the tyre itself stays one colour.
const HUB: [number, number][] = [
  [2, 1],
  [1, 1],
  [1, 2],
  [2, 2],
]

/**
 * The taxi at animation step `step`: the wheels turn a quarter, the road and
 * the wind lines slide one pixel; still, it parks with no wind.
 */
export const taxiCar = (step: number, isMoving: boolean): Bitmap => {
  const rows = CAR.map(r => [...r])
  const set = (x: number, y: number, c: string) => {
    const row = rows[y]
    if (row && x >= 0 && x < row.length) row[x] = c
  }
  const turn = ((step % HUB.length) + HUB.length) % HUB.length
  for (const wx of WHEEL_X) {
    WHEEL.forEach((row, dy) => [...row].forEach((c, dx) => c !== '.' && set(wx + dx, WHEEL_Y + dy, c)))
    const [hx, hy] = HUB[turn] ?? [1, 1]
    set(wx + hx, WHEEL_Y + hy, 'D')
  }
  for (let x = 0; x < CAR_WIDTH; x++) {
    if ((((x - step) % 6) + 6) % 6 < 4 && rows[9]?.[x] === '.') set(x, 9, 'R')
  }
  if (isMoving) {
    for (const [y, phase] of [
      [2, 0],
      [4, 3],
      [6, 1],
    ] as const) {
      for (let x = 16; x < CAR_WIDTH; x++) if ((((x - step + phase) % 5) + 5) % 5 < 2) set(x, y, 'S')
    }
  }
  return rows.map(r => r.join(''))
}

/**
 * The 7-row font drawn 10 pixels (5 terminal rows) tall: the top, middle and
 * bottom strokes doubled, which reads as a segment display.
 */
const TALL_ROWS = [0, 0, 1, 2, 3, 3, 4, 5, 6, 6]
export const tallBitmap = (b: Bitmap): Bitmap => TALL_ROWS.map(i => b[i] ?? '')

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const base64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

export type RasterCells = { columns: number; rows: number; cells: string }

/**
 * A bitmap as Raster cells, two pixel rows per cell: each letter coloured by
 * `palette` ('.' is the background), the upper pixel as the foreground of
 * '▀' and the lower as its background, so a cell can hold two colours.
 */
export const toRasterPalette = (b: Bitmap, palette: Record<string, number>, bg: number): RasterCells => {
  const columns = Math.max(1, bitmapWidth(b))
  const rows = Math.max(1, Math.ceil(b.length / 2))
  const words = new Uint32Array(columns * rows * 3)
  const colorAt = (x: number, y: number) => {
    const c = b[y]?.[x]
    return c === undefined || c === '.' ? undefined : (palette[c] ?? palette['#'])
  }
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < columns; x++) {
      const top = colorAt(x, 2 * r)
      const bottom = colorAt(x, 2 * r + 1)
      const i = (r * columns + x) * 3
      if (top !== undefined && bottom !== undefined && top === bottom) {
        words[i] = 0x2588
        words[i + 1] = top
        words[i + 2] = bg
      } else if (top !== undefined) {
        words[i] = 0x2580
        words[i + 1] = top
        words[i + 2] = bottom ?? bg
      } else if (bottom !== undefined) {
        words[i] = 0x2584
        words[i + 1] = bottom
        words[i + 2] = bg
      } else {
        words[i] = 0x20
        words[i + 1] = bg
        words[i + 2] = bg
      }
    }
  }
  return { columns, rows, cells: base64(new Uint8Array(words.buffer)) }
}

/** A one-colour bitmap ('#' lit) as Raster cells. */
export const toRaster = (b: Bitmap, fg: number, bg: number): RasterCells => toRasterPalette(b, { '#': fg }, bg)

/** 13660 -> "13,660" */
export const groupThousands = (n: number): string => {
  const s = String(Math.max(0, Math.round(n)))
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
