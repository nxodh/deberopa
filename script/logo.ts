/**
 * Rasterise assets/logo.png into half-block art for the terminal and print it.
 *   bun run script/logo.ts [columns]
 * The result is pasted into src/tui/logo.ts; the mark is the dark "V" on the off-white disc.
 */
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

function decodePng(buf: Buffer) {
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString("ascii", pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]!
      if (data[8] !== 8 || data[12] !== 0) throw new Error("only 8-bit non-interlaced PNG supported")
    } else if (type === "IDAT") idat.push(data)
    pos += 12 + len
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType as 0 | 2 | 4 | 6]
  if (!channels) throw new Error("unsupported colour type " + colorType)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!
      const a = x >= channels ? out[y * stride + x - channels]! : 0
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0
      let r: number
      if (filter === 0) r = v
      else if (filter === 1) r = v + a
      else if (filter === 2) r = v + b
      else if (filter === 3) r = v + ((a + b) >> 1)
      else {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      out[y * stride + x] = r & 255
    }
  }
  return { width, height, channels, data: out }
}

const png = decodePng(fs.readFileSync(path.join(import.meta.dir, "..", "assets", "logo.png")))
// "ink" = opaque and dark: the V itself
const ink = (x: number, y: number) => {
  const i = (y * png.width + x) * png.channels
  const alpha = png.channels === 4 ? png.data[i + 3]! : 255
  return alpha > 128 && png.data[i]! < 90
}

// bounding box of the V
let x0 = png.width, x1 = 0, y0 = png.height, y1 = 0
for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) if (ink(x, y)) {
  if (x < x0) x0 = x
  if (x > x1) x1 = x
  if (y < y0) y0 = y
  if (y > y1) y1 = y
}
const bw = x1 - x0 + 1
const bh = y1 - y0 + 1

function render(cols: number) {
  const px = cols
  const py = Math.round((cols * bh) / bw)
  const rows = Math.ceil(py / 2)
  const cover = (cx: number, cy: number) => {
    const sx0 = x0 + Math.floor((cx * bw) / px), sx1 = x0 + Math.floor(((cx + 1) * bw) / px)
    const sy0 = y0 + Math.floor((cy * bh) / py), sy1 = y0 + Math.floor(((cy + 1) * bh) / py)
    let n = 0, t = 0
    for (let y = sy0; y < Math.max(sy1, sy0 + 1); y += 2) for (let x = sx0; x < Math.max(sx1, sx0 + 1); x += 2) { t++; if (ink(x, y)) n++ }
    return n / t > 0.5
  }
  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    let line = ""
    for (let c = 0; c < px; c++) {
      const top = cover(c, r * 2)
      const bottom = r * 2 + 1 < py && cover(c, r * 2 + 1)
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " "
    }
    lines.push(line.replace(/\s+$/, ""))
  }
  return lines
}

const cols = Number(process.argv[2] ?? 30)
console.log(`bbox ${bw}x${bh}`)
console.log(render(cols).join("\n"))
