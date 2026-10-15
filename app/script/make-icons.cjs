"use strict"
// Builds the app icons from the project logo (../assets/logo.png): build/icon.png (Linux and the
// window), build/icon.ico (Windows), build/icon.icns (macOS) and build/icons/<size>.png.
// The logo is not square and its circle is off centre, so the circle is found, centred, cleaned of
// stray specks and given an even margin. Run it with Electron (it needs only nativeImage):
//   npx electron script/make-icons.cjs
const { app, nativeImage } = require("electron")
const fs = require("node:fs")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const source = path.resolve(root, "..", "assets", "logo.png")
const out = path.join(root, "build")

/** The circle in the source: centre and radius, from the opaque pixels (specks outside are ignored). */
function findCircle(bitmap, w, h) {
  const rows = new Uint32Array(h)
  const cols = new Uint32Array(w)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (bitmap[(y * w + x) * 4 + 3] > 200) {
        rows[y]++
        cols[x]++
      }
  const first = (arr, from, to, step) => {
    for (let i = from; i !== to; i += step) if (arr[i] >= 12) return i
    return -1
  }
  const minX = first(cols, 0, w, 1)
  const maxX = first(cols, w - 1, -1, -1)
  const minY = first(rows, 0, h, 1)
  const maxY = first(rows, h - 1, -1, -1)
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, r: (maxX - minX + (maxY - minY)) / 4 }
}

/** `size`-pixel square with the circle filling `fill` of the width; anti-aliased edge, no specks. */
function render(srcBitmap, w, h, circle, size, fill) {
  const buf = Buffer.alloc(size * size * 4)
  const R = (size * fill) / 2
  const k = R / circle.r
  const c = size / 2
  const inner = circle.r - 4 // colours are sampled inside the source circle: its edge pixels are mixed with the matte
  const sample = (sx, sy) => {
    const x0 = Math.max(0, Math.min(w - 2, Math.floor(sx)))
    const y0 = Math.max(0, Math.min(h - 2, Math.floor(sy)))
    const fx = Math.min(1, Math.max(0, sx - x0))
    const fy = Math.min(1, Math.max(0, sy - y0))
    const px = (x, y) => (y * w + x) * 4
    const out = [0, 0, 0]
    for (let ch = 0; ch < 3; ch++) {
      const a = srcBitmap[px(x0, y0) + ch] * (1 - fx) + srcBitmap[px(x0 + 1, y0) + ch] * fx
      const b = srcBitmap[px(x0, y0 + 1) + ch] * (1 - fx) + srcBitmap[px(x0 + 1, y0 + 1) + ch] * fx
      out[ch] = a * (1 - fy) + b * fy
    }
    return out
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c
      const dy = y + 0.5 - c
      const dist = Math.hypot(dx, dy)
      const alpha = Math.max(0, Math.min(1, R + 0.5 - dist))
      if (alpha === 0) continue
      const sd = Math.min(dist / k, inner)
      const scale = dist > 0 ? sd / (dist / k) : 1
      const [b, g, r] = sample(circle.cx + (dx / k) * scale, circle.cy + (dy / k) * scale) // bitmap is BGRA
      const i = (y * size + x) * 4
      buf[i] = b
      buf[i + 1] = g
      buf[i + 2] = r
      buf[i + 3] = Math.round(alpha * 255)
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function ico(entries) {
  // entries: [{ size, png }]; PNG-compressed images, which every Windows since Vista reads
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = 6 + entries.length * 16
  const dir = []
  for (const e of entries) {
    const d = Buffer.alloc(16)
    d[0] = e.size >= 256 ? 0 : e.size
    d[1] = e.size >= 256 ? 0 : e.size
    d.writeUInt16LE(1, 4)
    d.writeUInt16LE(32, 6)
    d.writeUInt32LE(e.png.length, 8)
    d.writeUInt32LE(offset, 12)
    offset += e.png.length
    dir.push(d)
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)])
}

function icns(chunks) {
  // chunks: [{ type, png }]
  const parts = chunks.map((c) => {
    const head = Buffer.alloc(8)
    head.write(c.type, 0, "ascii")
    head.writeUInt32BE(c.png.length + 8, 4)
    return Buffer.concat([head, c.png])
  })
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.write("icns", 0, "ascii")
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

app.whenReady().then(() => {
  const image = nativeImage.createFromPath(source)
  if (image.isEmpty()) throw new Error(`cannot read ${source}`)
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  const circle = findCircle(bitmap, width, height)
  console.log(`logo ${width}x${height}, circle centre ${circle.cx.toFixed(1)},${circle.cy.toFixed(1)} radius ${circle.r.toFixed(1)}`)

  fs.mkdirSync(path.join(out, "icons"), { recursive: true })
  const png = (size, fill) => render(bitmap, width, height, circle, size, fill).toPNG()
  // Windows and Linux: the circle fills the canvas almost completely (an even 4% margin)
  const FULL = 0.92
  // macOS draws no mask of its own: Apple's template keeps the artwork inside about 80%
  const MAC = 0.8

  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) fs.writeFileSync(path.join(out, "icons", `${size}.png`), png(size, FULL))
  fs.copyFileSync(path.join(out, "icons", "512.png"), path.join(out, "icon.png"))
  fs.writeFileSync(path.join(out, "icon.ico"), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png(size, FULL) }))))
  fs.writeFileSync(
    path.join(out, "icon.icns"),
    icns([
      { type: "icp4", png: png(16, MAC) },
      { type: "icp5", png: png(32, MAC) },
      { type: "icp6", png: png(64, MAC) },
      { type: "ic07", png: png(128, MAC) },
      { type: "ic08", png: png(256, MAC) },
      { type: "ic09", png: png(512, MAC) },
      { type: "ic10", png: png(1024, MAC) },
      { type: "ic11", png: png(32, MAC) },
      { type: "ic12", png: png(64, MAC) },
      { type: "ic13", png: png(256, MAC) },
      { type: "ic14", png: png(512, MAC) },
    ]),
  )
  console.log("wrote build/icon.png, icon.ico, icon.icns and build/icons/*.png")
  app.exit(0)
})
