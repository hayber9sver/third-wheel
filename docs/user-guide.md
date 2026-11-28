# Third Wheel user guide

Back to the [README](../README.md). Shortcuts are given as Cmd (macOS) / Ctrl (Windows).

**Third Wheel has no CAD inside.** It doesn't build or edit parts. Your AI agent does that in your own CAD and exports
a STEP file. That CAD can be Fusion, FreeCAD or SolidWorks, driven through their scripting or MCP, or CadQuery /
build123d code the agent writes. Third Wheel shows the STEP file: you mark spots, comment and talk them through with
the agent. The next version the agent exports opens with your notes.

**In this guide:**

- [Set up Claude Code](#set-up-claude-code): connect your AI agent to the app (once).
- [Other AI agents](#other-ai-agents): Codex, Gemini CLI, GitHub Copilot, Cursor, Cline, LM Studio, VS Code.
- [Projects: where your notes are saved](#projects-where-your-notes-are-saved): open a folder, add files.
- [Parts](#parts): several models in one project, such as a box and its lid.
- [Versions](#versions): add the next version of a part and keep your notes.
- [Mark up a model](#mark-up-a-model): select, paint, comment and send your review.
- [Talk to your agent (Agent tab)](#talk-to-your-agent-agent-tab): chat with the agent from inside the app.
- [Two-part fit check](#two-part-fit-check), [Troubleshooting](#troubleshooting), [Send feedback](#send-feedback)

## Set up Claude Code

The app comes with an **MCP server**: the small program your AI agent uses to talk to the app. You set it up once.
After that, Claude Code starts it by itself, and it finds the open app.

**No Node.js needed:** the installed app runs its MCP server itself. Built from source, the server runs with `node`.

1. **Mac:** move Third Wheel to **Applications** first. The setup points to where the app is, and a copy opened from
   the downloaded `.dmg` disappears when it is closed.
2. Click **AI: no agent yet** (bottom left) or **Set up your AI agent…** on the start page (also in the **Help**
   menu). The setup pop-up opens.
3. Pick where the tools show up: **This folder only** or **All my folders** (see
   [Where the tools show up](#where-the-tools-show-up)).
4. Click **Add Third Wheel to Claude Code**. It only writes a setup entry into Claude Code's settings, and it first
   shows you what will run (see [Nothing happens without your click](#nothing-happens-without-your-click)).
5. Start a **new** Claude Code session (or restart it). Claude Code connects when it starts.
6. **Check:** start Claude Code in that folder and type `/mcp`. `third-wheel` should be listed. The AI item in the app
   turns green when the agent calls it.

No button, or you'd rather do it by hand? See [Set it up yourself](#set-it-up-yourself).

### Where the tools show up

- **This folder only** (default): the open project's folder, or **Choose…** another one. Pick the folder you start
  Claude Code in. Inside a git project, the entry works anywhere in that project; otherwise not in subfolders. After
  you move or rename the folder, connect again: Claude Code keeps the entry under the old path.
- **All my folders**: every Claude Code session, in any folder. A folder's own entry still comes first.

### Nothing happens without your click

The button first shows what will run: the `claude` program it found (full path), the folder, and the exact
`claude mcp add …` command. If Claude Code already has a Third Wheel entry there, it says where that one points, and
the button in that box becomes **Replace and add**: nothing is removed without that click.

**Where it looks for Claude Code:** the terminal install, and the copy inside the Claude Code extension for VS Code /
Cursor. If it finds neither, **Look again, using my terminal's settings** asks your terminal's shell once (Mac: it
reads your `~/.zshrc`).

### The status line

The line above the button says whether Claude Code will find Third Wheel in that folder:

- **Set up ✓**: the entry Claude Code uses starts this app's server, the way this app needs. That entry comes from
  `~/.claude.json`, or from a `.mcp.json` in the folder or above.
- **Needs your yes**: a folder's `.mcp.json` counts only after you say yes to it in Claude Code. One you said no to is
  ignored.
- **Won't work yet**: **Why?** names the problem. For example, a `.mcp.json` points to a file that no longer exists,
  or there is a second Third Wheel entry (Claude Code warns about "multiple scopes"). **Remove the entry in …** under
  it removes an entry that is in the way. It first says what it runs or changes, and keeps a `.bak` of a changed file.

### The AI item (bottom left)

It says what the app knows. Click it any time for the setup pop-up.

- **AI: no agent yet**: no agent has used the app since it opened.
- **AI: listening** (green): an agent waits for your messages in the Agent tab.
- **AI: last call 5 min ago**: green while the call is recent.

### Set it up yourself

**Set it up yourself** (in the pop-up) shows the two options below, with the paths of your copy filled in, each with
**Copy**. Use them if the button isn't there (Claude Code wasn't found), or if you prefer to do it by hand. Then start
a new Claude Code session and check with `/mcp`, as in the steps above.

**Option 1: one command in a terminal.** It needs the `claude` command in your terminal. Run it in your CAD project
folder: the tools then show up when Claude Code starts in that folder. For the installed Mac app:

```sh
claude mcp add third-wheel --env ELECTRON_RUN_AS_NODE=1 -- "/Applications/Third Wheel.app/Contents/MacOS/Third Wheel" "/Applications/Third Wheel.app/Contents/Resources/mcp/third-wheel-mcp.js"
```

Built from source, it is `claude mcp add third-wheel -- node "/path/to/third-wheel/packages/mcp-server/build/third-wheel-mcp.js"`.
To have the tools in every folder, pick **All my folders** in the pop-up (it adds `--scope user`). Keep the quotes
around the paths.

**Option 2: a `.mcp.json` file.** Use it if the terminal says "claude: command not found" or "is not recognized" (for
example, you use Claude Code only inside VS Code). Put a file named `.mcp.json` in your CAD project folder. For the
installed Windows app:

```json
{
  "mcpServers": {
    "third-wheel": {
      "command": "C:\\Users\\you\\AppData\\Local\\Programs\\Third Wheel\\Third Wheel.exe",
      "args": [
        "C:\\Users\\you\\AppData\\Local\\Programs\\Third Wheel\\resources\\mcp\\third-wheel-mcp.js"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

Copy it from the pop-up rather than typing it. On Windows, every `\` in a path must be written `\\`, and the pop-up
does that for you. Finder and Windows Explorer refuse names that start with a dot: create the file in VS Code (New
File → `.mcp.json`) or in a terminal.

## Other AI agents

Third Wheel's MCP server is a standard local MCP server, so any agent app that can start one can use it. The formats
below follow each tool's own docs as of **2026-11-11** (Copilot CLI: **2026-11-22**).

**Not tested yet** with any tool except Claude Code. If one doesn't work for you, please tell us what it printed.

**Not supported or not recommended:**

- **ChatGPT (app or website)** can only reach MCP servers on the internet, not a program on your computer.
  (OpenAI's **Codex** can: see below.)
- **Local models** work only through an agent app that supports MCP: LM Studio, Cline, Continue or Goose. Ollama alone
  has no MCP. Small models often lose track of the review loop (open → wait → read → edit → answer each comment). Use
  the largest model your computer runs well.
- **Claude Desktop (the chat app)** is not recommended. It reportedly stops a tool after about a minute, and waiting
  for your review takes longer. Its chat also can't run your CAD script or save a STEP file. Use its **Code** tab
  instead: that is Claude Code ([set up Claude Code](#set-up-claude-code)).

**The app's setup pop-up.** Click the **AI:** item (bottom left) or **Set up your AI agent…** on the start page. Its
**Other** tab shows the setup most agents read, with the paths of your copy filled in, ready to copy. An agent gets its
own tab, with a button that does the setup for you, only once someone has tried it with the real program. So far
that's Claude Code. The sections below give each agent's setup by hand. Tried one and it works? Help others:
[Adding an AI agent](adding-an-agent.md).

**The two paths you need.** Every setup below starts the app's own program with `ELECTRON_RUN_AS_NODE=1` and gives it
the server file. For the installed app they are:

|         | Program (`command`)                                               | Server file (first `args` entry)                                                   |
| ------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| macOS   | `/Applications/Third Wheel.app/Contents/MacOS/Third Wheel`        | `/Applications/Third Wheel.app/Contents/Resources/mcp/third-wheel-mcp.js`          |
| Windows | `C:\Users\you\AppData\Local\Programs\Third Wheel\Third Wheel.exe` | `C:\Users\you\AppData\Local\Programs\Third Wheel\resources\mcp\third-wheel-mcp.js` |

- **Windows:** replace `you` with your user name, or copy the paths from the **Other** tab of the setup pop-up.
- **Mac:** move the app to **Applications** first.
- **Built from source:** the program is `node`, and the server file is `packages/mcp-server/build/third-wheel-mcp.js`
  in your third-wheel folder. Leave out `ELECTRON_RUN_AS_NODE`.

### Codex (OpenAI: CLI, IDE extension, desktop app)

The three share one settings file, `~/.codex/config.toml` (Windows: `C:\Users\you\.codex\config.toml`). Add this to
it, and create the file if it isn't there:

```toml
[mcp_servers.third-wheel]
command = "/Applications/Third Wheel.app/Contents/MacOS/Third Wheel"
args = ["/Applications/Third Wheel.app/Contents/Resources/mcp/third-wheel-mcp.js"]
tool_timeout_sec = 1800

[mcp_servers.third-wheel.env]
ELECTRON_RUN_AS_NODE = "1"
```

On Windows, put the paths in **single** quotes so the `\` stay as they are:
`command = 'C:\Users\you\AppData\Local\Programs\Third Wheel\Third Wheel.exe'` and
`args = ['C:\Users\you\AppData\Local\Programs\Third Wheel\resources\mcp\third-wheel-mcp.js']`.

**Keep `tool_timeout_sec = 1800`.** Codex stops a tool after 60 seconds by default. Waiting for your review and
opening a big file take longer, and listening to the Agent tab waits up to 25 minutes.

**By command:** `codex mcp add third-wheel --env ELECTRON_RUN_AS_NODE=1 -- "<program>" "<server file>"` adds the same
entry, but without the time limit. Add the `tool_timeout_sec` line to the file afterwards.

**Check:** `codex mcp list` in a terminal, or `/mcp` inside Codex.

### Gemini CLI

One command in a terminal. It adds Third Wheel for all your folders; leave out `-s user` for the current folder only:

```sh
gemini mcp add -s user --timeout 1800000 -e ELECTRON_RUN_AS_NODE=1 third-wheel "/Applications/Third Wheel.app/Contents/MacOS/Third Wheel" "/Applications/Third Wheel.app/Contents/Resources/mcp/third-wheel-mcp.js"
```

On Windows, use the two Windows paths from the table (normal `\`, keep the quotes).

**Keep `--timeout 1800000`** (30 minutes, in milliseconds). Gemini CLI stops a tool after 10 minutes by default, and
listening to the Agent tab waits up to 25.

**Or edit a settings file:** `~/.gemini/settings.json` (all folders) or `.gemini/settings.json` in your project
folder. Add the `third-wheel` entry from the [JSON below](#cursor-cline-lm-studio) under its `"mcpServers"`, with
`"timeout": 1800000` in it.

**Check:** `/mcp` inside Gemini CLI.

### GitHub Copilot CLI

Needs a GitHub Copilot plan. One command in a terminal (adds it for all your folders):

```sh
copilot mcp add third-wheel --timeout 1800000 --env ELECTRON_RUN_AS_NODE=1 -- "/Applications/Third Wheel.app/Contents/MacOS/Third Wheel" "/Applications/Third Wheel.app/Contents/Resources/mcp/third-wheel-mcp.js"
```

On Windows, use the two Windows paths from the table.

**Keep `--timeout 1800000`** (30 minutes, in milliseconds): waiting for your review or a chat message takes long.

The entry lands in `~/.copilot/mcp-config.json`. A `.mcp.json` in your project folder comes first if it also has a
`third-wheel` entry.

**Check:** `copilot mcp list`, or `/mcp` inside Copilot CLI. To chat in Third Wheel, start `copilot` in your project
folder and ask it to listen to Third Wheel.

### Cursor, Cline, LM Studio

They use the same JSON as Claude Code's `.mcp.json`. On Windows, copy it from the setup pop-up (every `\` must be
written `\\`). For the Mac app:

```json
{
  "mcpServers": {
    "third-wheel": {
      "command": "/Applications/Third Wheel.app/Contents/MacOS/Third Wheel",
      "args": ["/Applications/Third Wheel.app/Contents/Resources/mcp/third-wheel-mcp.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

Where it goes:

- **Cursor:** `~/.cursor/mcp.json` (Windows: `C:\Users\you\.cursor\mcp.json`) for all folders, or `.cursor/mcp.json`
  in your project folder. Check in Cursor Settings → MCP.
- **Cline** (VS Code extension): click the MCP Servers icon in Cline → **Configure** → **Configure MCP Servers**. That
  opens its settings file. Paste the `"third-wheel": { … }` part inside its `"mcpServers"`.
- **LM Studio** (0.3.17 or newer): **Program** tab on the right → **Install** → **Edit mcp.json**. Paste the
  `"third-wheel": { … }` part inside its `"mcpServers"`. Pick a model that supports tool use.

### VS Code (GitHub Copilot)

Copilot reads a `.mcp.json` in the workspace root (the same file name Claude Code uses). For all folders, it reads
`~/.copilot/mcp-config.json` (Windows: `C:\Users\you\.copilot\mcp-config.json`). Its format needs two extra lines,
`"type"` and `"tools"`:

```json
{
  "mcpServers": {
    "third-wheel": {
      "type": "stdio",
      "command": "/Applications/Third Wheel.app/Contents/MacOS/Third Wheel",
      "args": ["/Applications/Third Wheel.app/Contents/Resources/mcp/third-wheel-mcp.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" },
      "tools": ["*"]
    }
  }
}
```

**Older VS Code versions** read `.vscode/mcp.json` instead. That file uses `"servers"` in place of `"mcpServers"` and
has no `"tools"` line. VS Code drops that format in February 2027.

**Or use the Command Palette:** run **MCP: Add Server** (Cmd+Shift+P / Ctrl+Shift+P) and choose **Command (stdio)**. Fill in the
program, the server file and `ELECTRON_RUN_AS_NODE=1`. VS Code asks you to trust the server the first time it starts.

### Differences you may notice

- **Pictures:** `render_region` sends small pictures of the marked area. Some apps don't pass them to the model, or
  the model can't see images. The AI still gets every comment, marker and face as text; the pictures are optional.
- **Time limits:** `wait_for_review` gives up after about 2 minutes and answers "waiting"; the AI then calls it again.
  Listening to the Agent tab (`wait_for_message`) waits up to 25 minutes. An app that stops tool calls sooner breaks
  this (Codex and Gemini CLI do by default, see above): set its time limit to 30 minutes. Cline may have a per-server
  time limit too (not checked yet). If its MCP settings show one for third-wheel, set it to the longest.

## Projects: where your notes are saved

**In short:**

- Your notes (markers, comments, chats) are saved in a **`.thirdwheel` folder** next to your models, like `.git`. A
  _marker_ is a named colour you paint on the model (see [Mark up a model](#mark-up-a-model)). Your model files are
  never changed or copied. Nothing is written until you change something.
- **File ▸ Open folder…** (Cmd+O / Ctrl+O) opens a folder's project. **File ▸ Open Recent** and the start page list
  your recent ones. **File ▸ New project folder…** starts one in an empty folder.
- **Add file** (toolbar, or **File ▸ Add file…**, Cmd+I / Ctrl+I) adds a model from the project's folder. It asks:
  **New version of** the shown model, or **Separate part**? A new version shows the part's comments and gets its
  markers moved over. If the file has markers of its own, you pick which to use (see [Versions](#versions)).
- **Parts ▾** (toolbar) switches between the project's parts, and **Versions ▾** between the versions of the part
  shown: see [Parts](#parts) and [Versions](#versions).
- **Read-only:** sometimes the folder can't be written, or the project is open in another Third Wheel (here or on
  another computer). Then the status bar says **Read-only — not saved** (red dot) right away, and the window title
  ends in "(read-only)".
- **Git:** commit `.thirdwheel/` with your models; chats stay out of git by default.

### More about projects

- **One project per folder**, subfolders included (see [How projects and folders work](#how-projects-and-folders-work)).
  The AI doesn't need these files: it reads your notes through the app.
- **Opening:** **Open folder…** shows the model you looked at last, else its newest version. A folder without a
  project opens its only model, or shows the file picker inside it. A project with no model shown has its own page:
  its name and folder, **Add file…** and **Open another folder…**.
- **New project folder…** picks (or creates) an empty folder; then **Add file…** puts your first model in it. A folder
  that already has a project gets no second one: you're asked to **Open it** or **Pick another folder**.
- **Add file** details: with no model shown, a file whose name matches a part (`bracket_v2.step` ↔ `bracket.step`)
  asks the same about that part's newest version. If the names don't look like versions of each other, it checks once
  more. A file outside the project's folder can't be added (models are never copied): open its folder as a project
  instead.
- **Read-only** details: this happens with a read-only checkout or a zip. It also happens when the project is open in
  a second copy of Third Wheel, or on another computer via Dropbox / OneDrive (you can also **Take over**). Your
  changes are kept until you close the app. **File ▸ Save project as…** saves a copy in another folder, and the app
  saves there from then on. The model files stay where they are; the copy points to them.
- **Where is the folder?** On macOS, folders that start with a dot are hidden (in Finder, press Cmd+Shift+. to show
  them). Windows shows `.thirdwheel` as a normal folder.
- **Old notes files** (`<model>.thirdwheel.json`, from before projects) move into the project the first time you open
  a model in that folder. The old files are left as they were. An older Third Wheel still opens them, but only with
  the notes from before the move.
- **Git** details: the project's own `.gitignore` (written by the app when missing) keeps your conversations with the
  agent (`chats/`) and the `lock` out of the repo. Remove the `chats/` line to share them. The app never changes a
  `.gitignore` you edited. For the same line endings on Mac and Windows, add `.thirdwheel/** text eol=lf` to
  `.gitattributes`. In the repo's folder, paste one of these:
  - macOS / Linux terminal: `echo '.thirdwheel/** text eol=lf' >> .gitattributes`
  - Windows PowerShell: `Add-Content .gitattributes '.thirdwheel/** text eol=lf'`

### What the files next to your model contain

Before you share a CAD folder (a git repo, a zip, a shared drive), know what Third Wheel and your agent leave in it:

- **`.thirdwheel/project.json` and `marks/`**: part and file names, each version's path relative to the project
  folder and a content hash (a fingerprint of the file's contents), comments with their replies, marker paint. Meant to be shared. Only a version on another
  drive (Windows) is stored with its full path, which may include your user name.
- **`.thirdwheel/chats/`**: your conversations with the agent. **`.thirdwheel/lock`**: the computer's name while the
  project is open. Both are kept out of git by `.thirdwheel/.gitignore`.
- **`.mcp.json`** (if you made one): the full path to Third Wheel's MCP server on your computer, e.g.
  `/Users/<you>/…` or `C:\Users\<you>\…`. So it shows your user name: add it to your `.gitignore` if that matters.
- **`.claude/settings.local.json`** and **`.claude/settings.local.json.bak`** (from **Ask fewer permission
  questions**): the rules `mcp__third-wheel` and `Bash(<your CAD command>)` (on Windows also
  `PowerShell(<your CAD command>)`), plus anything else Claude Code saved there. Claude Code means this file to be
  personal, but ignores it in git only when it created the file itself. Add `.claude/settings.local.json*` to your
  `.gitignore`.
- **Old notes files** (`<model>.thirdwheel.json`, from before projects): their version list holds the full path of
  every version. The app only reads them; once they have moved into the project, you can delete them.

The token the agent uses to reach the app is not in the project. It lives in your user folder, readable only by you.

### How projects and folders work

The project is the folder, together with the `.thirdwheel` folder in it (hidden on macOS, visible on Windows). It
covers every subfolder too, unless a subfolder has a project of its own:

```
cad/                       ← project "cad" (cad/.thirdwheel)
├── bracket.step             part of "cad"
├── bracket_v2.step          a version of bracket.step
├── out/
│   └── bracket_v3.step      in a subfolder: still "cad"
└── lid/                   ← project "lid" (cad/lid/.thirdwheel), after Make this folder its own project…
    └── lid.step             part of "lid", not of "cad"
```

- Opening a model (double-click, Open folder…) uses the nearest `.thirdwheel` folder at or above the model's folder.
  Without one, the model's own folder becomes the project on your first change.
- The AI's `load_model` opens models only from the open project's folder and its subfolders (except those with a
  project of their own). To work on a model somewhere else, open that folder yourself (**Open folder…**). With no
  project open, the AI's first model opens its folder as the project.
- **File ▸ Make this folder its own project…** splits the shown model's folder off. Its models, their versions,
  comments and markers move into the new project; the chat stays with the parent.
- Moving or renaming the whole project folder is fine: models are stored relative to it.

## Parts

A project can hold more than one part, such as a box and its lid. A **part** is one model with all its versions
(`lid.step`, `lid_v2.step`, …).

- **Add a part:**
  1. Click **Add file** (or **File ▸ Add file…**, Cmd+I / Ctrl+I).
  2. Pick the file.
  3. Answer **Separate part**.

  The model you had open is listed as a part too. When the AI opens a project file without saying it's a new version
  (`load_model` without `revisionOf`), that file becomes a part as well.

- **Switch parts:** **Parts ▾** (toolbar, between **Add file** and **Versions ▾**) lists the project's parts in the
  order they were added. Each shows its name, its newest file, how many comments are still open, and ✓ if it's the
  part you're looking at. Pick a part to show its newest version. A part whose newest file was moved or deleted is
  greyed out ("not found"; hover for the path).
- **Each part has its own markers and comments.** All versions of a part share them (see [Versions](#versions)).
  Marker names are unique across the whole project, so "Marker 2" always means one marker.
- **Point to another part from a comment:** in the comment box, click **↔ Part ▾** and pick the other part, e.g. "this
  pocket must fit the lid". The link follows that part to its newest version. The AI sees the link and can open that
  part. A comment can't link to its own part.
- **A "new version" that is really another part:** when most markers get lost or the size is very different, Third
  Wheel asks whether it's a new version or a separate part. When the AI added the file, a notice says so instead (see
  [Versions ▸ Special cases](#special-cases)).
- **Two parts that turn out to be one:** add one part's file as **New version of** the other part to join them. Links
  between the two go away (the notice says how many).
- **Split a subfolder off:** **File ▸ Make this folder its own project…** moves the shown model's folder, with its
  parts, into a project of its own (see [How projects and folders work](#how-projects-and-folders-work)).
- **Do two parts fit?** See [Two-part fit check](#two-part-fit-check).

## Versions

A **version** is one file of a part: `part.step`, then `part_v2.step`, and so on. **Versions ▾** (toolbar) lists the
versions of the part you're looking at.

Export each CAD revision under a **new file name** (`part.step` → `part_v2.step` → `part_v3.step`), never over the old
one. The app keeps no copies, so an overwritten version can't be compared.

### Add a new version

1. Show the old version.
2. Click **Add file** (toolbar, next to **Open folder**), or **File ▸ Add file…** (Cmd+I / Ctrl+I).
3. Pick the new file.
4. Answer **New version of …**.

Your markers and comments move over. Markers on geometry that changed are flagged ⚠ Changed or Lost.

**When the AI makes the new version:** it calls `load_model` with the new file and `revisionOf` = the old version; the
result is the same. It works inside the project folder: each export goes there under a new file name (the app tells it
a free one). A file saved outside the project folder, or a new version saved over an old one, is refused. Nothing
changes in the window, and the AI is told where to save it instead (or to ask you, when it can't).

### Browse and compare versions

- **Versions ▾** lists every version of the part, newest first (also two versions made from the same one). **Compare**
  shows what changed. A version whose file was moved or renamed shows "not found": pick **Locate…** to point to it
  again.
- **Comments and paint:** comments belong to the part, so every version shows the same comments. Each version keeps
  its own paint. Earlier versions never change. A marker with no paint on the shown version, but used by a comment,
  shows faded in Markers: select it and paint to give that comment a place here.

### Special cases

- **The new file has markers of its own?** You're asked which markers it should use (hover a button for details):
  - **its own**: nothing moves;
  - the **earlier** version's: they move over, and the file's own go to a `….bak.json` backup;
  - **Both**: its own stay, and the earlier version's other markers move over.

  A marker of the new file whose colour is taken gets a free one (the notice says so). In projects from before marker
  names were unique, a marker of the new file named like an earlier one is that marker. In such projects, two markers
  with one name are renamed "Name (2)" once, with a notice.

- **Saved over the old file anyway?** One file name is one version. That version takes the new contents, and its
  markers move onto them (⚠ where the geometry changed). The old contents are not kept. Paint that can't move (a mesh
  file) goes to a `….bak.json` backup in `.thirdwheel/marks/`.
- **Looks like another part?** When most markers are lost or the size is very different, Third Wheel asks: "The files
  look very different". **New version** keeps it. **Separate part** takes it out of the versions and opens it on its
  own, without the markers that moved over. When the AI loaded the file, there is no question: the notice says so, and
  the AI is told too.
- **Wrong file added?** In **Versions ▾**, point at that version and pick **Remove from versions…**. The file and its
  paint stay. The versions made from it are now made from the one before it, and the comments stay with the part.
  Third Wheel stops suggesting that file as a version. To undo, show any version of the part and add the file again
  with **Add file → New version of …**.
- **One earlier version per file:** if you add a file that is already linked to another one, Third Wheel asks which
  one is right.

## Mark up a model

Show the AI what you mean on the model itself: paint or select the spot, write a comment, then ask your agent about
it.

A few words you'll see: a **face** is one surface of the part, such as the inside of a hole. An **edge** is where two
faces meet, and a **vertex** is a corner point. A **body** is one solid piece. A **marker** is a named colour you paint
on the model. You can also add a selection to it, and you write your comments about markers.

**A typical round:**

1. Click **File ▸ Open folder…** (Cmd+O / Ctrl+O) and pick the folder with your `.step` / `.stp` files.
2. Start your agent and let it listen in the **Agent** tab (see [Talk to your agent](#talk-to-your-agent-agent-tab)).
3. Point at the spot: press **B** for the **Brush** and paint over it. Or select a face or edge and add it to a marker.
4. Click **+ Comment** and write what you mean, for example "is this hole big enough?". The comment belongs to the
   active marker and gets a number on its card (#1).
5. Ask about it in the **Agent** tab, for example "What do you think of #1?". The agent answers under the comment. To
   go on, reply there: your reply goes to the agent at once.
6. Ask for a change, and the agent edits the CAD. The next version opens with your notes moved over.
7. When the agent says something is fixed, click **Confirm** or **Reopen**.

Want to go through the whole model first? Comment everywhere, then click **Send review** (top right) to send all new
comments at once.

### Open a model

- **File ▸ Open folder…** (Cmd+O / Ctrl+O) opens a folder with your `.step` / `.stp` files (see
  [Projects](#projects-where-your-notes-are-saved)). Double-clicking a file, or letting the AI open it, works too.
- **STL and 3MF** open in mesh-only mode: paint and comments work, but selecting faces or edges doesn't (a mesh has
  none). OpenSCAD exports meshes only, so its parts open this way. Open the STEP version later, and your paint moves
  onto it.

### Select and measure

- **Select** (V): hover highlights vertices, edges and faces. Click to select; drag a box to select many.
  - Double-click an edge for all edges that continue it smoothly (like the outline of a fillet, a rounded edge).
  - Double-click a face for the whole body.
  - Right-click → add the selection to a marker.
- **Dimensions**: with one or two things selected, their main size is drawn on the model: a hole's Ø, an edge's
  length, the distance between two faces or holes. Info lists the rest.
  - To change a size, comment on the selection, e.g. "make this 45 mm": the AI gets the exact value.
  - Clicking the comment later shows the same dimension again.

### Paint markers

- **Brush** (B): paint a marker on the surface.
- **Smart fill** (F): fill a whole face or a smooth area in one click.
- Hold **Shift** to erase. `[` and `]` change the brush size.
- **Markers** (right panel) are named colours. **+ Comment** writes a comment about the active marker.
- **Names:** double-click a marker's name to rename it. Names are unique in the project (all parts and versions), so
  you and the AI always mean the same marker. A name that's taken is refused.

### Send your review and read the answers

- **Send review** (top right) sends your new comments when you're done going through the model. Its number counts the
  comments the AI hasn't had yet.
  - With an agent listening in the Agent tab, they go to it at once.
  - When the AI asked for a review (rainbow banner), this answers it.
  - Without either, the button says **Copy review** and copies a short message to paste into the AI chat.
- **↔ Part ▾** in the comment box links the comment to another part of the project ("this pocket must fit the lid").
  The link follows that part to its newest version (see [Parts](#parts)).
- **Answers:** the AI answers in each comment's thread. When it says something is fixed, you **Confirm** or
  **Reopen**.
- **Resolved markers:** a marker is resolved when every comment on it is closed (your **Resolve**, **Won't fix** or
  **Confirm**).
  - It disappears from the model, loses its ⚠ Changed / ✕ Lost flag, and can't be painted with.
  - A marker that another, still open comment uses stays as it is.
  - **Show resolved** shows resolved markers faded. Clicking one of their comments shows the marker in full colour;
    **Reopen** brings it back.

### Shortcuts and mouse

Press `?` for all keyboard shortcuts. Mouse buttons (Fusion, Onshape or Slicer style) are set in the status bar.

## Talk to your agent (Agent tab)

The **Agent** tab (next to **Bodies**, top left) talks to the agent you started in your terminal. Third Wheel never
starts the agent or signs in for you: the agent and its memory live in your terminal.

### Start a chat

1. Open your project folder (**Open folder…**).
2. Connect your agent ([Set up Claude Code](#set-up-claude-code) or [Other AI agents](#other-ai-agents)) and start it
   in that folder. The setup pop-up's **Chat in Third Wheel** part has the exact terminal line and the start phrase,
   each with **Copy**. The terminal line is `cd '<project folder>' && claude` (Windows PowerShell:
   `cd -LiteralPath '<folder>'; claude`).

   A live line under them shows how far it got: **Waiting for Claude Code to start…** → **Connected** →
   **Listening ✓**. **Connected** means Claude Code started Third Wheel's tools; it warns when that happened in another
   folder than the project's.

3. Paste the start phrase in the agent's terminal (the tab shows it with a **Copy** button):
   _Listen to Third Wheel: call the third-wheel MCP tool wait_for_message in a loop. If you don't have that tool, say
   so and stop._ The tab's top line turns green: **listening**. If the agent says it doesn't have that tool, it isn't
   connected yet: **How to connect…** on the tab opens the setup.
4. Write in the message box. **Cmd+Enter** / **Ctrl+Enter** sends; Enter starts a new line.

The message box shows once a project is open and an agent has listened since the app opened. Until then, the tab shows
these steps in its place. Earlier topics stay readable.

### Three ways to reach the agent

- the **Agent tab**, for general questions and instructions ("look at #1 and #3");
- a **reply under a comment**, for one spot. It goes to the agent at once, and the agent answers in that thread. A
  reply goes out when you post it: undo removes it here, not from what the agent already read;
- **Send review**, for all your new comments at once. They wait for it, so the agent doesn't start halfway through
  your review.

### While the agent works

- **Progress:** you see **…** with its latest step, in the topic you asked it in. Other topics show **Working on your
  message in topic "…" →**; click it to open that topic.
- **The answer** shows under the agent's name, e.g. **Claude Code >_** (the mark says it runs in your terminal). The
  steps that led to it are folded under it ("▸ 3 steps").
- **An answer stays in the topic you asked in**, also after **+ New topic**, or when you opened another project
  meanwhile (it is saved in that project's folder). The topic you are looking at gets a short line **Answered in topic
  "…" →** that opens it; for another project, the line names the project. An earlier topic you have open shows new
  answers as they come. Otherwise **🕘 Earlier topics** shows a count, and the topic says "n new" in its list.
- **Queued messages:** messages you send while the agent works, or while it isn't listening, wait and go to it
  together. Each message tells the agent which model was on screen when you wrote it.
- **Replies under a comment:** when the agent answers under a comment, the tab shows **↳ Replied under #3 …**. Click
  it to show the comment. The card has a blue dot until you look at it.

### When the agent is slow or stops

- **Taking a while?** shows after 30 s without a new step. It usually means the agent is asking for permission in its
  terminal. After 10 minutes without any call to Third Wheel, the hint says **No news for 10 min — check its
  terminal**. Third Wheel can't tell a long step or a permission question from an agent that stopped.
- **Ask fewer permission questions** (setup pop-up, under Chat in Third Wheel) makes Claude Code ask less.
  - It adds two lines to Claude Code's personal settings for the project folder (`.claude/settings.local.json`):
    `mcp__third-wheel` (all Third Wheel tools) and `Bash(<your CAD command>)` (default `python *.py`; change it to what
    your agent runs; on Windows also `PowerShell(…)`).
  - It shows the exact lines first and writes them only when you click **Add these lines**. Other settings stay, and
    the old file is kept as `.bak`.
  - Restart Claude Code if it is running.
- **Not listening** (amber): the agent stopped calling Third Wheel. Paste the start phrase in its terminal again (the
  tab has a **Copy** button). After 2 h without a message, the app stops the loop to save your usage. Quitting Third
  Wheel stops it too.
- **Usage:** each idle round of listening is a short model call (with Claude Code, about 13 per hour while nothing
  happens).

### What the agent knows

- **What a new connection is told:** when an agent connects, Third Wheel gives it a short catch-up, never the whole
  conversation:
  - the model on screen;
  - versions added since an agent was last here;
  - how many comments are open per part;
  - the models you showed;
  - the summary the agent saved last time;
  - the last few messages.

  **▸ Caught up** shows exactly what was passed; click it to unfold. The agent can page back through older messages
  when it needs them. It can also save a short summary of the topic for the next time (**▸ Saved a summary of this
  topic**).

- **Who is listening:** a grey line marks when an agent connects ("Claude Code connected · 14:02"). Another marks when
  it goes quiet for a while ("Claude Code stopped listening · 14:40"). Third Wheel can't tell whether the agent quit or
  is just busy, and it can't see `/clear` in the terminal.
- **The rail:** while an agent listens, a thin line runs beside what this connection has received. Earlier lines are
  faded. After **+ New topic**, the rail runs off the top: the agent still remembers the earlier topic.

### Topics and history

- **+ New topic** (top of the tab) starts an empty page. Your agent keeps its memory; to make it forget, type `/clear`
  in its terminal.
- **🕘 Earlier topics** lists this project's topics, newest first, named by their first message. An earlier topic
  opens **read-only**, with **Back to current topic** above it. **Show earlier messages** at the top loads older lines
  of a long topic. A comment link in an earlier topic opens that comment on its part's newest version.
- **Saved with the project:** the conversation is kept in the project folder (`.thirdwheel/chats/`). So it goes along
  when you move or zip the folder, and opening the project again shows it. It stays out of git unless you choose
  otherwise (see [Projects](#projects-where-your-notes-are-saved)). Each time a model is shown, a grey line says so
  ("Opened bracket_v2.step", "Agent loaded bracket_v3.step — new version of bracket_v2.step").

### The panel

The panel floats over the 3D view. Drag its right edge to resize it; click **‹** or the open tab to fold it. Fit (Z)
frames the model in the part of the view the panel leaves free. A number on the folded Agent tab counts unread
answers.

## Two-part fit check

Do two printed parts fit together? Example: a lid that clips onto a box. Ask the AI:
_"Check how `lid.step` fits on `box.step`."_

1. The AI opens both and asks for one review. The banner has a button per part.
2. Switch between the parts and paint the matching areas on each (the clip and its slot, the mating faces). Add a
   comment like "these must slide together".
3. One **Send review** answers for both.

The AI lines the parts up and compares the faces you marked. It reports the gap per feature (walls, radii, depth) and
what that means for FDM / resin / machining. It asks before changing anything.

## Troubleshooting

- **The AI says the app isn't running**: start Third Wheel and keep it open. The agent can't start it for you.
- **"claude: command not found"**: use the `.mcp.json` option in [Set it up yourself](#set-it-up-yourself).
- **Another agent (Codex, Cursor …) says a tool timed out**: raise its tool time limit (see
  [Other AI agents](#other-ai-agents)).
- **Moved or reinstalled the app somewhere else**: click **Add Third Wheel to Claude Code** again (or copy the command
  again). The setup points to where the app was.
- **The first start shows a security warning**: expected for now (see the [README](../README.md#download)).
- **Starting the app a second time** brings the open window to the front: it runs once at a time.
- **Building from source went wrong**: see [Development: if something goes wrong](development.md#if-something-goes-wrong).

## Send feedback

**Help ▸ Send feedback…** (or **Send feedback** at the bottom of the start page) asks where you'd like to write it:

- **Private form…** opens a short Google Form (a few optional questions, no account needed). Only the Third Wheel
  developer reads it.
- **GitHub issue…** opens a new public issue (needs a GitHub account).

Your browser opens, and you write and submit there. The app fills in only its version, your operating system and the
connected agent's name (untick the line to leave that out). Your model, notes and chats are never part of it.
