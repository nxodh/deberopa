"use strict"
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("deberopa", {
  info: () => ipcRenderer.invoke("app:info"),
  openProject: (dir) => ipcRenderer.invoke("project:open", dir),
  closeProject: (dir) => ipcRenderer.invoke("project:close", dir),
  api: (dir, method, path, body) => ipcRenderer.invoke("api", { dir, method, path, body }),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  onEvent: (callback) => {
    const handler = (_e, payload) => callback(payload)
    ipcRenderer.on("event", handler)
    return () => ipcRenderer.removeListener("event", handler)
  },
  onProjectExit: (callback) => {
    const handler = (_e, payload) => callback(payload)
    ipcRenderer.on("project:exited", handler)
    return () => ipcRenderer.removeListener("project:exited", handler)
  },
})
