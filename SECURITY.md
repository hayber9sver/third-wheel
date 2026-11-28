# Security

## Report a vulnerability

Please report security problems **privately**, not in a public issue: on GitHub, open the
[Security tab](https://github.com/XiLaoTr/third-wheel/security) and click **Report a vulnerability**. Say what you
found, how to reproduce it (a small file or steps), and which version and system (macOS / Windows) you used. You will
get an answer in the report; please wait for a fix before you talk about it in public.

Only the latest release gets fixes.

## What counts

Third Wheel runs on your computer and talks to an AI agent you started. Things we want to hear about, for example:

- **The app bridge:** another program, a web page or another user on the same computer reaching the app's local
  connection without the token, or reading the token.
- **What the AI reads:** text from a model or notes file (part names, file names, comments) that reaches the agent with
  hidden characters or tricks the agent into doing something the user didn't ask for.
- **Files:** opening a STEP, STL, 3MF or project folder that makes the app write outside the project folder, run code,
  or crash in a way that loses notes.
- **Settings the app writes** for an agent (the **Set up your AI agent** pop-up) that allow more than they say.

Not a vulnerability here: an agent following instructions the user typed, or anything that needs someone who already
controls your user account.

How the bridge and the AI's input are protected is described in [docs/mcp-tools.md](docs/mcp-tools.md).
