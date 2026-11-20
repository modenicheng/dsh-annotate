/**
 * Icon build: one geometry table, the SVG and every PNG generated from it.
 *
 * The manifest needs PNG (Chrome does not accept an SVG in `icons`), the docs
 * and the future store uploads want the vector, and drawing one from the other
 * by hand is how the two drift. Everything below comes from `geometry()`, and
 * `--check` re-renders in memory and fails when a committed file differs, so CI
 * can hold the PNGs to the source — the same generated-and-committed contract
 * as the protocol copies (D3).
 *
 * There is no dependency here: rasterising six shapes by supersampling and
 * writing the PNG by hand is smaller than the devDependency that would do it,
 * needs no registry at build time, and produces byte-identical output on every
 * machine, which is what makes `--check` meaningful.
 *
 *   node scripts/build-icons.mjs            # write packages/extension/icon/
 *   node scripts/build-icons.mjs --check     # verify, exit 1 when stale
 *   node scripts/build-icons.mjs --preview   # also write .tmp-icons/preview.png
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const iconDir = join(root, 'packages', 'extension', 'icon')
const previewPath = join(root, '.tmp-icons', 'preview.png')

/** Every shape is authored in this square and scaled to the requested size. */
const MASTER = 128

/** Palette. Blue is the product, orange is the mark that was made. */
const BLUE = '#1f6feb'
const ORANGE = '#f0883e'
const WHITE = '#ffffff'

/**
 * @typedef {object} Shape
 * @property {'rrect' | 'circle' | 'polygon'} type
 * @property {number} [cx] centre x, for both kinds
 * @property {number} [cy] centre y
 * @property {number} [w] width in master units
 * @property {number} [h] height in master units
 * @property {number} [r] corner radius (rrect) or radius (circle)
 * @property {number} [rot] rotation in degrees around (cx, cy)
 * @property {string} color `#rrggbb`
 * @property {Array<[number, number]>} [points] polygon vertices, master units
 * @property {number} [opacity] 0..1, default 1
 */

/**
 * The cursor silhouette from IconOven's `cursor-click-sharp` (MIT, no
 * attribution required, commercial use allowed), in its own 24-unit grid with
 * the click arc dropped. The path is all straight lines, so it is a polygon
 * and needs no curve support here.
 * @type {Array<[number, number]>}
 */
const CURSOR = [
  [9.66, 8.96],
  [18.59, 12.54],
  [19.75, 13.0],
  [18.56, 13.38],
  [15.44, 14.37],
  [14.25, 14.75],
  [13.85, 15.94],
  [12.9, 18.81],
  [12.5, 20.0],
  [12.09, 18.82],
  [8.91, 9.68],
  [8.5, 8.5],
]

/**
 * Place the cursor with its tip at (x, y), scaled `scale` times.
 * @param {number} scale
 * @param {number} x
 * @param {number} y
 * @returns {Array<[number, number]>}
 */
function cursor(scale, x, y) {
  return CURSOR.map(([cx, cy]) => [x + (cx - 8.5) * scale, y + (cy - 8.5) * scale])
}

/**
 * The layers in paint order: tile, the pointing hand, the numbered marker it
 * dropped.
 *
 * The marker is the product's visible artifact (D23: the numbered tag pinned
 * over the anchor), so it is the one element that survives every size; the
 * numeral inside it only fits from 48 px up. A 16 px toolbar icon is 256
 * pixels and there the badge is a coloured dot, which is the correct trade —
 * the cursor carries the meaning at that size.
 *
 * @param {'mark' | 'full'} detail
 * @param {number} [badgeScale] optical correction, not a proportion change
 * @returns {Shape[]}
 */
function geometry(detail = 'full', badgeScale = 1) {
  /** @type {Shape[]} */
  const shapes = [
    { type: 'rrect', cx: 64, cy: 64, w: 128, h: 128, r: 30, color: BLUE },
    { type: 'polygon', points: cursor(5.0, 26, 24), color: WHITE },
    { type: 'circle', cx: 89, cy: 93, r: 18 * badgeScale, color: ORANGE },
  ]

  if (detail === 'full') {
    // The numeral: a stem plus a flag rotated 135 degrees, which is how a
    // sans-serif "1" is drawn. Below 48 px it is eight pixels of white inside a
    // 36 px badge and reads as noise, so those sizes get the plain marker.
    shapes.push(
      { type: 'rrect', cx: 89.5, cy: 95, w: 5.2, h: 21, r: 2, color: WHITE },
      { type: 'rrect', cx: 86, cy: 88.5, w: 10.5, h: 4.4, r: 1.7, rot: 135, color: WHITE },
    )
  }

  return shapes
}

/**
 * Layer the shapes over a transparent canvas, then average the supersamples
 * down. Supersampling is what gives the round edges their anti-aliasing without
 * a rendering library.
 * @param {Shape[]} shapes
 * @param {number} size output edge in pixels
 * @returns {Buffer} RGBA
 */
function rasterize(shapes, size) {
  const ss = 4
  const big = size * ss
  const scale = big / MASTER
  // Premultiplied RGBA, so compositing is a source-over add.
  const px = new Float64Array(big * big * 4)

  for (const shape of shapes) {
    const alpha = shape.opacity ?? 1
    const [red, green, blue] = rgb(shape.color)
    const box = bounds(shape)
    const x0 = Math.max(0, Math.floor(box.x * scale))
    const y0 = Math.max(0, Math.floor(box.y * scale))
    const x1 = Math.min(big - 1, Math.ceil((box.x + box.w) * scale))
    const y1 = Math.min(big - 1, Math.ceil((box.y + box.h) * scale))

    for (let py = y0; py <= y1; py += 1) {
      for (let pxi = x0; pxi <= x1; pxi += 1) {
        // Sample the pixel centre in master units; at ss = 4 that is already a
        // 16-sample average per output pixel, which is smoother than the eye.
        if (!inside(shape, (pxi + 0.5) / scale, (py + 0.5) / scale)) continue
        const offset = (py * big + pxi) * 4
        const below = 1 - alpha
        px[offset] = red * alpha + px[offset] * below
        px[offset + 1] = green * alpha + px[offset + 1] * below
        px[offset + 2] = blue * alpha + px[offset + 2] * below
        px[offset + 3] = alpha + px[offset + 3] * below
      }
    }
  }

  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const offset = ((y * ss + sy) * big + (x * ss + sx)) * 4
          red += px[offset]
          green += px[offset + 1]
          blue += px[offset + 2]
          alpha += px[offset + 3]
        }
      }
      const samples = ss * ss
      const a = alpha / samples
      const at = (y * size + x) * 4
      // Un-premultiply for the stored (straight) alpha.
      out[at] = a === 0 ? 0 : clamp255((red / samples / a) * 255)
      out[at + 1] = a === 0 ? 0 : clamp255((green / samples / a) * 255)
      out[at + 2] = a === 0 ? 0 : clamp255((blue / samples / a) * 255)
      out[at + 3] = clamp255(a * 255)
    }
  }
  return out
}

/**
 * @param {Shape} shape
 * @param {number} x
 * @param {number} y
 */
function inside(shape, x, y) {
  if (shape.type === 'polygon') return inPolygon(shape.points, x, y)
  if (shape.type === 'circle') {
    return Math.hypot(x - shape.cx, y - shape.cy) <= shape.r
  }
  let dx = x - shape.cx
  let dy = y - shape.cy
  if (shape.rot !== undefined) {
    // Rotate the sample into the shape's own frame instead of rotating pixels.
    const angle = (-shape.rot * Math.PI) / 180
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const rx = dx * cos - dy * sin
    const ry = dx * sin + dy * cos
    dx = rx
    dy = ry
  }
  const halfW = shape.w / 2
  const halfH = shape.h / 2
  const radius = Math.min(shape.r ?? 0, halfW, halfH)
  const qx = Math.abs(dx) - halfW + radius
  const qy = Math.abs(dy) - halfH + radius
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const insideBox = Math.min(Math.max(qx, qy), 0)
  return outside + insideBox - radius <= 0
}

/**
 * Even-odd ray casting. Every polygon here is a simple (non-self-intersecting)
 * silhouette, so the fill rule never comes into play.
 * @param {Array<[number, number]>} points
 * @param {number} x
 * @param {number} y
 */
function inPolygon(points, x, y) {
  let result = false
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const [xi, yi] = points[index]
    const [xj, yj] = points[previous]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) result = !result
  }
  return result
}

/**
 * The axis-aligned box a shape can touch, rotation included.
 * @param {Shape} shape
 */
function bounds(shape) {
  if (shape.type === 'polygon') {
    const xs = shape.points.map((point) => point[0])
    const ys = shape.points.map((point) => point[1])
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  }
  if (shape.type === 'circle') {
    return { x: shape.cx - shape.r, y: shape.cy - shape.r, w: shape.r * 2, h: shape.r * 2 }
  }
  const rad = ((shape.rot ?? 0) * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  const w = shape.w * cos + shape.h * sin
  const h = shape.w * sin + shape.h * cos
  return { x: shape.cx - w / 2, y: shape.cy - h / 2, w, h }
}

/**
 * A PNG encoder, because zlib is the only thing missing and it is built in.
 * @param {Buffer} rgba
 * @param {number} width
 * @param {number} height
 */
function png(rgba, width, height) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0
  header[11] = 0
  header[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * @param {string} type
 * @param {Buffer} data
 */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** @param {Buffer} buffer */
function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** @param {string} hex */
function rgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map((channel) => channel / 255)
}

/** @param {number} value */
function clamp255(value) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

/** Trim a number to something an SVG reader likes. @param {number} value */
function num(value) {
  return Number(value.toFixed(2))
}

/**
 * The vector twin of a raster. Same shapes, so `--check` and the store upload
 * describe one drawing.
 * @param {Shape[]} shapes
 */
function svg(shapes, displaySize = MASTER) {
  const body = shapes.map((shape) => {
    const fill = shape.color
    const opacity = shape.opacity === undefined ? '' : ` fill-opacity="${num(shape.opacity)}"`
    if (shape.type === 'polygon') {
      const points = shape.points.map(([x, y]) => `${num(x)},${num(y)}`).join(' ')
      return `  <polygon points="${points}" fill="${fill}"${opacity}/>`
    }
    if (shape.type === 'circle') {
      return `  <circle cx="${num(shape.cx)}" cy="${num(shape.cy)}" r="${num(shape.r)}" fill="${fill}"${opacity}/>`
    }
    const transform =
      shape.rot === undefined ? '' : ` transform="rotate(${num(shape.rot)} ${num(shape.cx)} ${num(shape.cy)})"`
    const x = num(shape.cx - shape.w / 2)
    const y = num(shape.cy - shape.h / 2)
    return `  <rect x="${x}" y="${y}" width="${num(shape.w)}" height="${num(shape.h)}" rx="${num(shape.r ?? 0)}" fill="${fill}"${opacity}${transform}/>`
  })
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${displaySize}" height="${displaySize}" role="img" aria-label="dsh-marker">`,
    ...body,
    '</svg>',
    '',
  ].join('\n')
}

/**
 * What is committed, and what each file is for. Sizes are the ones the two
 * stores and both browsers actually read: 16 and 32 are the toolbar, 48 is the
 * extension manager row, 96 the high-DPI row, 128 the store listing.
 *
 * The plugin's own `icon.svg` is emitted here too. D23 makes this one product
 * with two halves, and a plugin row drawn with a different mark from the
 * toolbar button would read as two projects; the plugin row renders at about
 * 20 px, so it gets the vector at the detail level that still holds there.
 */
const OUTPUTS = [
  { path: join(iconDir, 'icon.svg'), build: () => svg(geometry('full')) },
  { path: join(iconDir, 'icon-16.png'), build: () => png(rasterize(geometry('mark', 1.15), 16), 16, 16) },
  { path: join(iconDir, 'icon-32.png'), build: () => png(rasterize(geometry('mark'), 32), 32, 32) },
  { path: join(iconDir, 'icon-48.png'), build: () => png(rasterize(geometry('full'), 48), 48, 48) },
  { path: join(iconDir, 'icon-96.png'), build: () => png(rasterize(geometry('full'), 96), 96, 96) },
  { path: join(iconDir, 'icon-128.png'), build: () => png(rasterize(geometry('full'), 128), 128, 128) },
  { path: join(root, 'packages', 'plugin', 'icon.svg'), build: () => svg(geometry('mark'), 32) },
]

/**
 * Every size on a light and a dark surface, upscaled with nearest neighbour so
 * the small sizes can be judged at 1:1 detail instead of guessed at.
 */
function preview() {
  const sizes = [16, 32, 48, 128]
  const zoom = 4
  const gap = 12
  const cell = 128 * zoom
  const width = gap + sizes.length * (cell + gap)
  const height = gap + 2 * (cell + gap)
  const rgba = Buffer.alloc(width * height * 4)
  const rows = ['#f6f7f9', '#1b1f24']

  rows.forEach((background, row) => {
    fill(rgba, width, gap, gap + row * (cell + gap), width - gap * 2, cell, rgb(background), 1)
    sizes.forEach((size, index) => {
      const detail = size >= 48 ? geometry('full') : geometry('mark', size === 16 ? 1.15 : 1)
      const art = rasterize(detail, size)
      const originX = gap + index * (cell + gap) + Math.floor((cell - size * zoom) / 2)
      const originY = gap + row * (cell + gap) + Math.floor((cell - size * zoom) / 2)
      blit(rgba, width, art, size, originX, originY, zoom)
    })
  })

  return { buffer: png(rgba, width, height), width, height }
}

/**
 * @param {Buffer} target
 * @param {number} targetWidth
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number[]} color
 * @param {number} alpha
 */
function fill(target, targetWidth, x, y, w, h, color, alpha) {
  for (let py = y; py < y + h; py += 1) {
    for (let pxi = x; pxi < x + w; pxi += 1) {
      const at = (py * targetWidth + pxi) * 4
      target[at] = color[0] * 255
      target[at + 1] = color[1] * 255
      target[at + 2] = color[2] * 255
      target[at + 3] = alpha * 255
    }
  }
}

/**
 * Nearest-neighbour blit, so the zoom shows real pixels rather than a resample
 * of them.
 * @param {Buffer} target
 * @param {number} targetWidth
 * @param {Buffer} source
 * @param {number} size
 * @param {number} x
 * @param {number} y
 * @param {number} zoom
 */
function blit(target, targetWidth, source, size, x, y, zoom) {
  for (let py = 0; py < size * zoom; py += 1) {
    for (let pxi = 0; pxi < size * zoom; pxi += 1) {
      const from = (Math.floor(py / zoom) * size + Math.floor(pxi / zoom)) * 4
      const alpha = source[from + 3] / 255
      if (alpha === 0) continue
      const at = ((y + py) * targetWidth + (x + pxi)) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        target[at + channel] = source[from + channel] * alpha + target[at + channel] * (1 - alpha)
      }
      target[at + 3] = 255
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const check = args.has('--check')
  /** @type {string[]} */
  const stale = []
  /** @type {string[]} */
  const missing = []

    for (const output of OUTPUTS) {
    const bytes = Buffer.from(output.build())
    const label = relative(root, output.path).split('\\').join('/')
    if (check) {
      if (!existsSync(output.path)) {
        missing.push(label)
        continue
      }
      const current = await readFile(output.path)
      if (!current.equals(bytes)) stale.push(label)
      continue
    }
    mkdirSync(dirname(output.path), { recursive: true })
    writeFileSync(output.path, bytes)
    console.log(`build-icons: wrote ${label} (${bytes.length} bytes)`)
  }

  if (check) {
    if (missing.length > 0) {
      console.error(`build-icons: missing ${missing.join(', ')}`)
      process.exit(1)
    }
    if (stale.length > 0) {
      console.error(`build-icons: ${stale.join(', ')} does not match the geometry; run \`pnpm run icons\``)
      process.exit(1)
    }
    console.log(`build-icons: ok (${OUTPUTS.length} file(s) match the geometry)`)
    return
  }

  if (args.has('--preview')) {
    const sheet = preview()
    mkdirSync(dirname(previewPath), { recursive: true })
    writeFileSync(previewPath, sheet.buffer)
    console.log(`build-icons: preview at .tmp-icons/preview.png (${sheet.width}x${sheet.height})`)
  }
}

await main()
