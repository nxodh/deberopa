export interface Bridge {
  info(): Promise<{ version: string; platform: string; recents: string[]; testProject: string }>
  openProject(dir?: string): Promise<{ ok: boolean; canceled?: boolean; error?: string; dir?: string; name?: string }>
  closeProject(dir: string): Promise<void>
  api(dir: string, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status?: number; data?: any; error?: string }>
  listDir(dir: string, rel: string): Promise<{ ok: boolean; error?: string; entries?: { name: string; dir: boolean }[] }>
  readFile(dir: string, rel: string): Promise<{ ok: boolean; error?: string; text?: string; mtimeMs?: number }>
  statFile(dir: string, rel: string): Promise<{ ok: boolean; missing?: boolean; mtimeMs?: number }>
  writeFile(dir: string, rel: string, text: string, expectedMtimeMs?: number, force?: boolean): Promise<{ ok: boolean; conflict?: boolean; error?: string; mtimeMs?: number }>
  openExternal(url: string): Promise<void>
  onEvent(callback: (payload: { dir: string; event: { type: string; properties?: any } }) => void): () => void
  onProjectExit(callback: (payload: { dir: string; code: number | null }) => void): () => void
}

declare global {
  interface Window {
    deberopa: Bridge
  }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** One call to a project's `deberopa serve`; throws with the server's own message. */
export async function request<T = any>(dir: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await window.deberopa.api(dir, method, path, body)
  if (!res.ok) throw new ApiError(res.status ?? 0, res.error ?? "Request failed")
  return res.data as T
}
