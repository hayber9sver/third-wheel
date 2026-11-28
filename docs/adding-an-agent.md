# Adding an AI agent to the setup pop-up

Each tab of **Set up your AI agent** comes from one small file in
[`apps/desktop/agents/`](../apps/desktop/agents/). To add an agent, or fix one, you change only that file, not the app's
code. The file picks one of four built-in engines (three with a button, `manual` without):

| Engine     | What the button does                                                          | Example                                                                                                  |
| ---------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `command`  | Finds the agent's program and runs its own "add an MCP server" command        | [`claude.json`](../apps/desktop/agents/claude.json), [`gemini.json`](../apps/desktop/agents/gemini.json) |
| `settings` | Writes the entry into the agent's settings file (JSON or TOML), with a backup | [`codex.json`](../apps/desktop/agents/codex.json)                                                        |
| `link`     | Opens the agent's install link; the agent asks the user to confirm            | [`cursor.json`](../apps/desktop/agents/cursor.json), [`vscode.json`](../apps/desktop/agents/vscode.json) |
| `manual`   | No button: only text to copy                                                  | [`other.json`](../apps/desktop/agents/other.json)                                                        |

## What a file may do

The app's checker limits what a file can do. A test runs it on every file, so a pull request with a broken or unsafe
file fails.

- A `command` agent runs only its own program (`name`, `name.exe` or `name.cmd`) with the arguments in the file. Shells
  and script runners such as `bash`, `cmd`, `pwsh`, `node` or `python` are refused.
- A `settings` agent writes only one file under your home folder, ending in `.json` or `.toml` like its format.
- A `link` agent opens only a `cursor:`, `vscode:` or `vscode-insiders:` link (a new kind of link is a code change).
- Texts can't hold hidden characters, and unknown fields or placeholders are refused.

A command is always shown to the user before it runs, and an existing entry is replaced only after they agree.

## Steps

1. **Copy the closest example** to `apps/desktop/agents/<id>.json`. `<id>` is short and lower case (`copilot`); the
   file's `"id"` must be the same.
2. **Fill it in** from the agent's own documentation ([fields below](#the-fields)). Editors that read JSON schemas (VS
   Code and others) check the file as you type, through `"$schema": "./agent.schema.json"`.
3. **Set the agent's tool time limit to 30 minutes** if it has one: a field in `settings.entry`, or a flag in
   `command.add` such as `--timeout`. Why: while the user is in the Agent tab, `wait_for_message` waits up to 25
   minutes.
   - A test fails when a `command` or `settings` agent has no limit of at least that long.
   - The test reads `tool_timeout_sec` (seconds) or `--timeout` (milliseconds). Tell us in the pull request if your
     agent names it differently.
4. **Leave `"tested": null` for now.** Agents nobody has tried are hidden in the app.
5. **Try it with the real agent.** Run the app from source (inside `third-wheel/`) with the hidden tabs shown:

   ```sh
   THIRD_WHEEL_SHOW_UNTESTED=1 pnpm dev        # macOS
   ```

   ```powershell
   $env:THIRD_WHEEL_SHOW_UNTESTED=1; pnpm dev  # Windows PowerShell
   ```

   Then check:
   - **Button:** click **AI: no agent yet** (bottom left) → your tab → the button. Restart the agent. It should list
     `third-wheel` and be able to open a model (ask it to open `test-models/bracket.step`).
   - **Copy:** click **Copy** and paste it by hand into a clean setup.
   - **Review wait:** ask the agent to request a review, and wait 3 minutes before you click **Send review**.
   - **Chat wait:** ask it to listen to Third Wheel (Agent tab), and send a message after 15 minutes.

   In both waits the agent should still answer, without a time-out error.

6. **Fill in `"tested"`** with the agent's version, the OS and what you tried, e.g.
   `"Copilot CLI 1.4 on Windows 11 (button + copy)"`. Only then does the tab appear for everyone.
7. **Run the checks** inside `third-wheel/` (a test checks every file in the folder):

   ```sh
   pnpm lint && pnpm typecheck && pnpm test
   ```

8. **Open a pull request.** Say which agent version and OS you tried, and what the agent printed.

## Agents waiting for a tester

These files exist but are hidden until someone tries them ([steps 5–6](#steps)). You need the agent and an account for
it:

| File                                                  | Agent                         | Account needed                 |
| ----------------------------------------------------- | ----------------------------- | ------------------------------ |
| [`codex.json`](../apps/desktop/agents/codex.json)     | Codex (CLI, IDE, desktop app) | ChatGPT plan or OpenAI API key |
| [`gemini.json`](../apps/desktop/agents/gemini.json)   | Gemini CLI                    | Google account                 |
| [`copilot.json`](../apps/desktop/agents/copilot.json) | GitHub Copilot CLI            | GitHub Copilot plan            |
| [`cursor.json`](../apps/desktop/agents/cursor.json)   | Cursor                        | Cursor account                 |
| [`vscode.json`](../apps/desktop/agents/vscode.json)   | VS Code with GitHub Copilot   | GitHub Copilot plan            |

What we don't know yet, and what to tell us:

- whether the button works;
- whether `/mcp` (or the agent's own list) shows `third-wheel`;
- whether the time limit above holds (the agent doesn't stop a 15-minute wait);
- anything the agent printed.

A small fix to the file in the same pull request is welcome.

What public sources say about the tool time limit (not tried; check it when you test):

- **Copilot CLI:** `copilot mcp add` takes `--timeout <ms>` (saved in `~/.copilot/mcp-config.json`). Its docs don't say
  whether it is the limit for one tool call or only for starting the server, nor what the largest value is.
- **Cursor:** no documented setting. User reports differ by version and connection type (from about 60 s to about 60
  min for a tool call). If yours stops `wait_for_message` before 25 minutes, tell us the time it stopped at.
- **VS Code with GitHub Copilot:** no documented MCP tool time limit or setting.

## The fields

### Placeholders

The app fills these in:

| Placeholder    | Becomes                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `{name}`       | `third-wheel`                                                                                       |
| `{command}`    | the program that starts Third Wheel's MCP server                                                    |
| `{serverPath}` | the server file                                                                                     |
| `"{env}"`      | in JSON templates, as a whole value: the environment the server needs (left out when there is none) |

### Every file

- **`label`:** the agent's name in sentences.
- **`tab`:** the tab text.
- **`order`:** tabs are sorted by it.
- **`tested`:** who tried it with the real program (version, OS, what), or `null`.
- **`engine`:** `command`, `settings`, `link` or `manual`; the part with the same name must be there.

### `command`

- **`program`:**
  - `name` (macOS);
  - `windows`: file names, most likely first (`x.exe`, npm's `x.cmd`);
  - `folders` under `~/` where installers put it;
  - optional `editorExtension`: folder-name start of an editor extension that carries its own copy.

  The app also looks on PATH and in the Homebrew / npm folders.

- **`add`:** the arguments after the program. `"{scope}"` and `"{env}"` expand to several arguments:
  `scopes.<scope>.args` and, per environment variable, `env` (with `{key}` and `{value}`).
- **`remove`:** the arguments that remove an entry; `{where}` = the entry's scope name.
- **`scopes`:** `user` ("All my folders") and / or `folder` ("This folder only"; shows the folder switch and runs the
  command in that folder). `where` = how the agent names that scope.
- **`entries`:** where an existing entry is found (`file`, `key` path to it, its `where`), in the order the agent uses
  them.
  - A `file` under `~/` may name a folder variable in `fileEnv` (e.g. `CODEX_HOME`).
  - A plain file name (like `.mcp.json`) is looked for in the folder and the ones above it.
  - `{project}` in `key` = the folder.
- **`entries[].approval`** (optional): for an entry the agent asks about before using it (Claude Code: a folder's
  `.mcp.json`).
  - `files`: `file` + `key` path to the object (`{project}` allowed). A plain file name is looked for in the folder and
    its git project's top folder.
  - The names of the `enabled` / `disabled` lists and the `all` flag in those objects.

  A no anywhere wins; the check then ignores that entry.

- **`check: true`:** shows a status line (is the entry the agent will use this app's?).
- **`timeoutSec`:** how long a command may take.

### `settings`

- `file` under `~/` (+ optional `fileEnv`);
- `format`: `json` or `toml`;
- `key` path to the entry (TOML: its table, e.g. `["mcp_servers", "{name}"]`);
- `entry`: the template.

The old file is kept as `.bak`. A file the app can't change safely is left alone, and the user copies the text instead.

### `link`

- `url` with `{config}` (and `{name}`); it must be an app's own link (`cursor:`, `vscode:` …).
- `config`: the template.
- `encode`: `base64` or `json`.

### `chat` (optional)

The "Chat in Third Wheel" part.

- `start`: what to type in a terminal to start the agent (a plain program name).
- `allow` (optional): "Ask fewer permission questions".
  - `file`: a `.json` file relative to the folder the agent starts in (never `~/` or `..`);
  - `key` path to the list of rules;
  - `rules` (`{name}` = the server's name, `{cad}` = the CAD command the user types);
  - `windowsRules` (added on Windows only).

### `manual`

The copy box: `"command": true`, `"settings": true` and / or `"json": { … }`.

### `texts`

| Key                              | Used for                                                 |
| -------------------------------- | -------------------------------------------------------- |
| `button`                         | the button's text                                        |
| `buttonHint`                     | `{file}` = the settings file                             |
| `notFoundHint` / `notFoundTitle` | when the program isn't found                             |
| `title`                          | above the copy box                                       |
| `where`                          | where it goes and how to check                           |
| `after`                          | after a click, e.g. "Restart X: /mcp lists third-wheel." |
| `scopeFolder` / `scopeUser`      | the ⓘ of the folder switch                               |

Texts are plain: no hidden characters. Keep them short; the user reads them in a small pop-up.

## When an agent needs more

If an agent can't be set up with these fields (for example it needs a step none of the engines does), open an issue
and describe what it needs. A new engine is a code change, reviewed like any other.
