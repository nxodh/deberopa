import { createRoot } from "react-dom/client"
import { App } from "./App"
import { init } from "./store"

// anything that escapes React is written to the console with its stack (the app test collects it)
window.addEventListener("error", (e) => console.error("window error:", e.error?.stack ?? e.message))
window.addEventListener("unhandledrejection", (e) => console.error("unhandled rejection:", (e.reason && e.reason.stack) || String(e.reason)))

void init()
createRoot(document.getElementById("root")!).render(<App />)
