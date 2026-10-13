import fs from "node:fs/promises"
import path from "node:path"
import { Paths } from "../global"

export type Credential = { type: "api"; key: string } | { type: "oauth"; access: string; refresh?: string; expires?: number }

type AuthFile = Record<string, Credential>

async function read(): Promise<AuthFile> {
  try {
    return JSON.parse(await fs.readFile(Paths.auth, "utf8")) as AuthFile
  } catch {
    return {}
  }
}

async function write(data: AuthFile) {
  await fs.mkdir(path.dirname(Paths.auth), { recursive: true })
  // Credentials are secrets: owner read/write only (best effort on Windows, where ACLs govern).
  await fs.writeFile(Paths.auth, JSON.stringify(data, null, 2), { mode: 0o600 })
  await fs.chmod(Paths.auth, 0o600).catch(() => {})
}

export async function allCredentials(): Promise<AuthFile> {
  return read()
}

export async function getCredential(providerID: string): Promise<Credential | undefined> {
  return (await read())[providerID]
}

export async function setCredential(providerID: string, credential: Credential) {
  const data = await read()
  data[providerID] = credential
  await write(data)
}

export async function removeCredential(providerID: string): Promise<boolean> {
  const data = await read()
  if (!(providerID in data)) return false
  delete data[providerID]
  await write(data)
  return true
}
