# Vedecaps for VS Code

Opens the [Vedecaps](https://github.com/nxodh/vedecaps) terminal agent beside your editor and types the file or selection you are looking at into its prompt.

Requires the `vedecaps` command (see the project README for the one-line installer).

| Command | Default key | What it does |
|---|---|---|
| Vedecaps: Open | `Ctrl+Alt+V` (`Cmd+Alt+V`) | Starts Vedecaps in a terminal beside the editor, or shows the one that is running |
| Vedecaps: Add Selection to Prompt | `Ctrl+Alt+K` (`Cmd+Alt+K`) | Types `@path/to/file#L10-20` into the prompt (not sent until you press Enter) |
| Vedecaps: Add File to Prompt | context menu | Types `@path/to/file` |

Settings: `vedecaps.command` (path to the executable) and `vedecaps.arguments` (extra arguments).

Install from a `.vsix`: `code --install-extension vedecaps.vsix`.
