# Third Wheel — beta tester guide

Thanks for trying Third Wheel! It's an app for **talking about a 3D part with an AI**. You open the part, paint on it
or select its faces and edges, and write comments. Then you talk them through with your AI agent in the app's
**Agent** tab. When you agree on a change, the agent changes the part and shows you the new version, with your notes
moved over.

This is an early test version. Something will go wrong — that's what the beta is for. Please tell me: see
[Tell me what happened](#5-tell-me-what-happened).

Plan **30–60 minutes**: 10 to install and connect, 15 for the first try, the rest to explore and write to me. You're
also welcome to use it as much as you like.

You need:

- A Mac (macOS 12 or newer) or a Windows 10 / 11 PC.
- An **AI agent that can use tools on your computer**: Claude Code, Codex, Gemini CLI, Copilot CLI, Cursor, VS Code
  with Copilot, Cline or LM Studio. The ChatGPT app or website **won't work** (see
  [What doesn't work yet](#4-what-doesnt-work-yet)).
- The installer from **[Releases](https://github.com/XiLaoTr/third-wheel/releases/latest)** (`.dmg` for Mac, `.exe`
  for Windows).
- The test part, the **Square Wheel cube** (Third Wheel's own test model). Download `square-wheel.step` and
  `square-wheel_v2.step` from the
  [square-wheel folder](https://github.com/XiLaoTr/third-wheel/tree/main/test-models/square-wheel): click each file,
  then the download button ↓ at the top right.

## 1. Install

**Mac**

1. Open `Third-Wheel-…-mac.dmg` and drag **Third Wheel** into **Applications**.
2. Start it from Applications (not from the open `.dmg` window).
3. The first start shows **"Apple could not verify “Third Wheel”…"**. That's expected: the app isn't signed with a
   paid Apple certificate yet. Click **Done** (not **Move to Bin**).
4. Open **System Settings → Privacy & Security** and scroll down to **"“Third Wheel” was blocked…"**.
5. Click **Open Anyway**, then **Open Anyway** again (it may ask for your password).

On macOS 14 or older, steps 4–5 are different: right-click the app in Applications → **Open** → **Open**.

You only do this once.

**Windows**

1. Run `Third-Wheel-…-win-x64.exe`.
2. **"Windows protected your PC"** appears. That's expected: the app isn't signed with a paid certificate yet.
   Click **More info** → **Run anyway**.
3. Follow the installer. Third Wheel is then in the Start menu.

You should see the start page with **Open folder…** and **Set up your AI agent…**.

## 2. Set up your AI agent

You do this once, in the app.

1. Click **Set up your AI agent…** on the start page (later: the **AI:** item at the bottom left).
2. Pick your agent's tab: **Claude Code** or **Other**.

- **Claude Code** has **one button** that sets it up for you (Add Third Wheel to Claude Code). Click it, then
  **start a new session**.
- **Other** shows what to copy, with the paths of your computer filled in. Use **Copy** — don't type paths by hand.
  The [user guide](user-guide.md#other-ai-agents) says where it goes for Codex, Gemini CLI, Copilot CLI, Cursor and
  VS Code.
- **Codex users:** the setup includes `tool_timeout_sec = 1800`. Keep it, or Codex gives up while it waits for you.

**Check it worked:** ask your agent _"Which Third Wheel tools do you have?"_ It should list tools such as
`load_model` and `get_annotations`. In Claude Code you can also type `/mcp` and look for `third-wheel`.

More detail per agent: [user guide → Other AI agents](user-guide.md#other-ai-agents) and
[Set up Claude Code](user-guide.md#set-up-claude-code).

**Keep Third Wheel open** while you work: your agent talks to the open app and can't start it for you.

## 3. First try (15 minutes)

This tutorial walks you through most of the tools. You'll use the Square Wheel cube: the logo's square wheel as a
30 mm cube, with the round third wheel pinned into its side.

**Get ready.**

1. Make a new folder, e.g. `Third Wheel test` in your Documents, and put `square-wheel.step` in it. Leave
   `square-wheel_v2.step` out of it for now (e.g. in Downloads): you'll need it in step 5.
2. In Third Wheel, click **Open folder…** and pick that folder. The cube opens (it's the only STEP file there).
3. Start your agent in that folder. For Claude Code, Codex, Gemini CLI and Copilot CLI, the setup pop-up's
   **Chat in Third Wheel** part has the line to copy. Cursor / VS Code: open the folder there.
4. Click the **Agent** tab (top left, next to **Bodies**). Copy the start phrase it shows and paste it into your agent.
   The tab turns green and shows **listening**. More in
   [user guide → Talk to your agent](user-guide.md#talk-to-your-agent-agent-tab).

**Using Cursor, VS Code, Cline or LM Studio?** So far, the **Agent** tab's setup covers only the four agents named in
step 3, so skip step 4. In the tutorial, write your messages in your agent's own window instead. After each comment
or reply, click **Send review** (top right) so the agent gets it.

**1. Look around.** By default the mouse works like Fusion 360:

- **Shift + middle-drag** turns the view.
- **Middle-drag** moves it.
- The **wheel** zooms.
- Trackpad: Shift + swipe turns, swipe moves, pinch zooms.

Used to Onshape or a slicer (PrusaSlicer, OrcaSlicer: left-drag turns)? Switch to their mouse buttons in the status
bar at the bottom. Press `?` any time for all shortcuts.

**2. Brush a spot and comment on it.**

1. Click **Brush** in the toolbar (or press `B`).
2. Paint over the **front antenna**: the thin rod with a ball on top, above the side with the smile. `[` and `]` make
   the brush smaller / bigger; hold **Shift** to erase.
3. In the right panel, click **+ Comment** and write: _These antennas look fragile. Will they print?_ The comment card
   gets the number **#1**.

**3. Select a hole and comment on it.**

1. In the **Bodies** tab (top left), click the eye next to **Third wheel**. The wheel is hidden.
2. Click **Select** in the toolbar (or press `V`). Move the mouse over the cube: vertices (corners), edges and faces
   (surfaces) light up.
3. Click the rim of the **middle hole** on the side where the wheel was. Its size, **Ø5.1 mm**, appears on the model.
4. Right-click → **Add to marker ▸ New marker**. A second marker (new colour; your paint was the first) now holds that
   edge.
5. Click **+ Comment** and write: _Will the pin fit in this hole when printed?_ This is comment **#2**.
6. Click the eye next to **Third wheel** again to show the wheel.

Tip: **Smart fill** (`F`) paints a whole face in one click.

**4. Ask about both.**

1. In the **Agent** tab, write: _What do you think of #1 and #2?_
2. Press `Cmd+Enter` (Mac) / `Ctrl+Enter` (Windows) to send it.

While the agent works, you see its steps. It answers under each comment, and the tab shows **↳ Replied under #1**
(click it to jump to the comment). A question doesn't need a new version.

**5. Talk it through.**

1. Click comment **#2**.
2. In the **Reply…** box at the bottom of the comment, write for example: _Yes, make the pin 0.25 mm smaller than the
   hole._

A reply goes to the agent at once.

Third Wheel has no CAD inside. In real use, your agent would now change the part in your own CAD and export the next
version as a new STEP file. For this tutorial, that next version is ready-made, so you don't need a CAD:

3. Move `square-wheel_v2.step` into your test folder. This version has a looser pin, one eye moved up and no smile.
4. Tell the agent: _I've put the new version in the folder: open square-wheel_v2.step as a new version of
   square-wheel.step and answer under #2._

**6. Look at the new version.** When the agent is done, Third Wheel shows `square-wheel_v2.step`. Check:

- Your two markers **moved over** onto the new version (a notice says so).
- A marker on a spot the new version changed gets a badge:
  - **⚠ Changed**: check where it landed, then click **✓ Looks right**.
  - **✕ Lost**: dots show where it was, and its comment is kept. Click **✕ Dismiss**.
- Comment #2 has the agent's answer in its thread.
- **Versions ▾ → Compare with previous version** shows what changed between the two versions.

**7. Confirm or reopen.** Do this for each comment the agent says it fixed:

- If it's right, click **✓ Confirm**.
- If not, click **Reopen** and write why in the **Reply…** box. It goes to the agent at once.

That's the whole loop. 🎉 For fun, ask in the **Agent** tab: _Square wheels don't roll. Make it round?_

### More to try

**Go through the whole model first.** Comment on every spot, then click **Send review** (top right). All your new
comments go to the agent at once.

**Optional: let the AI build a part from scratch.** Use Third Wheel with an AI and CAD to build a real part! Your
agent needs to be able to make CAD for this (usually with FreeCAD, Fusion, CadQuery or build123d). If it can't, that's
useful to know too: tell me which agent and model.

**Your own files:** open a folder with your own STEP files (**Open folder…**), or an STL / 3MF from your slicer. STL
and 3MF get paint and comments only: a mesh has no faces or edges to select. To see this, try `square-wheel.stl` from
the same square-wheel folder.

## 4. What doesn't work yet

- **ChatGPT (app or website):** it can't reach programs on your computer. OpenAI's **Codex** can.
- **Ollama on its own** and other chat apps without "MCP" tool support. Local models work only through an agent app
  that supports MCP (LM Studio, Cline, Continue, Goose), and small models often lose track of the review loop.
- **Agents other than Claude Code are untested.** Codex, Gemini CLI, Copilot CLI, Cursor, VS Code, Cline and LM Studio are set up from
  their docs. If yours fails, what it printed is the most useful thing you can send me.
- **Some agents don't see pictures.** The AI still gets every comment and marked face as text, so it should work.

**Known issues** (no need to report these):

- **Saving a new version over the old file** loses the comparison: the app keeps no copies. Always use a new name
  (`part_v2.step`, `part_v3.step` …). Third Wheel tells the agent a name that isn't taken yet.
- **No "Close" menu item** yet. To get back to the start page, quit and restart Third Wheel. **Open folder…** works any
  time.
- **After many versions**, painted spots can get a bit ragged at the edges. Paint over them again if needed.
- **Very large or detailed parts** can:
  - make a big brush stutter,
  - freeze the app for a second when a new version opens,
  - freeze it for 5–15 seconds when you turn on **Compare**.
- **Compare works between STEP files only.** It is greyed out between an STL / 3MF and a STEP version.

## 5. Tell me what happened

**How to send it:** in the app, click **Help ▸ Send feedback…** (or **Send feedback** at the bottom of the start
page). Choose the private form or a public GitHub issue. Or just send me a message.

Anything is welcome, good or bad. Short is fine. Most useful:

1. **What you tried** and **what happened** (and what you expected instead).
2. **Your computer:** Mac or Windows, and its version.
3. **Your AI agent and model**, e.g. "Codex, GPT-5" or "Claude Code, Opus".
4. **A screenshot** of the app or the agent window when something looked wrong. Mac: `Shift+Cmd+4`. Windows:
   `Win+Shift+S`.
5. **If your markers or comments looked wrong** (missing, in the wrong place): the notes.
   - They are in the `.thirdwheel` folder in the part's folder. On a Mac, press `Cmd+Shift+.` in Finder to show it.
   - Zip that folder and send it, but leave out its `chats` folder: it holds your conversations with the agent.
   - Third Wheel 0.1 kept the notes in a file next to the part instead, named like the part plus `.thirdwheel.json`,
     e.g. `part_v2.step.thirdwheel.json`.
   - Please send the `.step` file too, if you can share it.
6. Anything that was **confusing**: a word you didn't understand, a button you couldn't find, a step in this guide
   that didn't match what you saw.

**If you'd like to think bigger** (all optional, answer any or none, or just tell me what you think in your own
words):

- Would you use this on a real part? Why or why not?
- Where would you rather talk to the AI: in its own window, or in Third Wheel's **Agent** tab? Or would you want
  Third Wheel inside your AI chat instead?
- Who else in your team or lab would need it?

Thank you!
