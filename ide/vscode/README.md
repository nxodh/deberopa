# Deberopa for VS Code

Opens the [Deberopa](https://github.com/nxodh/deberopa) terminal agent beside your editor and types the file or selection you are looking at into its prompt.

Requires the `deberopa` command (see the project README for the one-line installer).

| Command | Default key | What it does |
|---|---|---|
| Deberopa: Open | `Ctrl+Alt+V` (`Cmd+Alt+V`) | Starts Deberopa in a terminal beside the editor, or shows the one that is running |
| Deberopa: Add Selection to Prompt | `Ctrl+Alt+K` (`Cmd+Alt+K`) | Types `@path/to/file#L10-20` into the prompt (not sent until you press Enter) |
| Deberopa: Add File to Prompt | context menu | Types `@path/to/file` |

Settings: `deberopa.command` (path to the executable) and `deberopa.arguments` (extra arguments).

Install from a `.vsix`: `code --install-extension deberopa.vsix`.
