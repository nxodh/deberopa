/**
 * Serve dist/ the way GitHub Releases serves a release, so the installers and `vedecaps upgrade`
 * can be exercised before anything is published:
 *   bun run script/release-server.ts [dist] [port]
 *   VEDECAPS_RELEASE_URL=http://127.0.0.1:<port> sh install.sh
 */
import path from "node:path"
import pkg from "../package.json"

const dist = path.resolve(process.argv[2] ?? "dist")
const version = pkg.version
const server = Bun.serve({
  port: Number(process.argv[3] ?? 0),
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/latest") return new Response(null, { status: 302, headers: { location: `${url.origin}/tag/v${version}` } })
    const prefix = `/download/v${version}/`
    if (url.pathname.startsWith(prefix)) {
      const name = url.pathname.slice(prefix.length)
      if (!/^[\w.-]+$/.test(name)) return new Response("bad name", { status: 400 })
      const file = Bun.file(path.join(dist, name))
      if (await file.exists()) return new Response(file)
    }
    return new Response("not found", { status: 404 })
  },
})
console.log(server.port)
