/**
 * AI status in the status bar + the "Set up your AI agent" pop-up (one tab per agent).
 * The tabs come from the agent description files (`apps/desktop/agents/`; only tested ones unless
 * the window was opened with `?agents=all`), texts from `shared/agents.ts` (tested); this file only
 * wires them to the DOM. One-click Connect shows what it will run first and asks before replacing.
 * An agent with the folder switch uses the scope panel (`connect-panel-claude`), every other the
 * agent panel.
 */
import type { AgentDesc } from '../../shared/agent-desc.js';
import { visibleAgents } from '../../shared/agent-list.js';
import {
  agentPanel,
  agentResultText,
  commandText,
  hasScopeSwitch,
  jsonSnippet,
} from '../../shared/agents.js';
import {
  ago,
  aiStatusView,
  type AiActivity,
  type ConnectPlan,
  type ConnectResult,
  type ConnectTarget,
  type McpScope,
  type McpSetup,
} from '../../shared/ai-status.js';
import type { ChatStatus } from '../../shared/chat.js';
import {
  confirmLead,
  confirmText,
  lastPart,
  removeFixLabel,
  removeFixText,
  replaceShort,
  samePath,
  type FoundEntry,
} from '../../shared/claude-setup.js';
import { setupConnectChat } from './connect-chat.js';

/** The label says "N min ago": refresh it this often. */
const REFRESH_MS = 30_000;

/** The last agent chosen in the pop-up. */
const AGENT_KEY = 'connect-agent';

/** The tabs: tested agents only, unless dev / e2e opened the window with `?agents=all`. */
const AGENTS: readonly AgentDesc[] = visibleAgents(
  new URLSearchParams(location.search).get('agents') === 'all',
);

function agentOf(id: string): AgentDesc | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** The remembered tab if it is still shown, else the first one. */
function loadAgent(): string {
  const first = AGENTS[0]?.id ?? '';
  try {
    const v = localStorage.getItem(AGENT_KEY);
    return v !== null && agentOf(v) ? v : first;
  } catch {
    return first; // storage unavailable: start on the first tab
  }
}

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} missing from index.html`);
  return found;
}

export interface AiConnect {
  /** Open the pop-up (status item, start view link); `chat`: scroll to "Chat in Third Wheel". */
  open(at?: 'chat'): void;
  /** For tests: the current activity. */
  activity(): AiActivity;
  /** The Agent tab's status: "AI: listening" in the status bar, the pop-up's live chat status. */
  setChatStatus(status: ChatStatus): void;
}

/** The folder of a file path (either separator). */
function folderOf(file: string): string {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return i > 0 ? file.slice(0, i) : file;
}

/**
 * `getProjectFolder` / `getModelPath`: the shown project and model; the project's folder (else the
 * model's) is the default for "This folder only" and where the chat steps start the agent.
 */
export function setupAiConnect(
  getModelPath: () => string | undefined,
  getProjectFolder: () => string | undefined,
): AiConnect {
  const api = window.thirdWheel;
  const item = el('ai-status');
  const label = el('ai-status-label');
  const dialog = el('connect-dialog') as HTMLDialogElement;
  let activity: AiActivity = { bridge: 'starting' };
  let listening = false;
  let setup: McpSetup | undefined;
  let scope: McpScope = 'folder';
  let agent: string = loadAgent();
  /** What each agent's button needs (program, settings file): undefined = still looking, null = not found. */
  const found = new Map<string, string | null>();
  /** The agent whose one-click is running. */
  let connecting: string | undefined;
  /** The last one-click outcome per agent, while the pop-up stays open. */
  const results = new Map<string, ConnectResult>();
  /** What Connect would run, per command agent; refreshed on open and on every change. */
  const plans = new Map<string, ConnectPlan>();
  /** The agent whose "about to run" box is open. */
  let confirming: string | undefined;
  /** "This folder only": the folder chosen with Choose…; undefined = the shown project's (or model's). */
  let chosenFolder: string | undefined;
  /** The entry whose "Remove" box is open (a fix the check offered), and the last removal's outcome. */
  let fixing: FoundEntry | undefined;
  let fixResult: { ok: boolean; text: string } | undefined;
  /** Bumped per plan request and agent: an older answer must not overwrite a newer one. */
  const planTickets = new Map<string, number>();
  /** The shown agent with the folder switch (its scope panel), if the shown tab is one. */
  const scoped = (): AgentDesc | undefined => {
    const a = agentOf(agent);
    return a && hasScopeSwitch(a) ? a : undefined;
  };
  /** Every agent with the folder switch (their plans follow the switch and the folder). */
  const scopedIds = AGENTS.filter(hasScopeSwitch).map((a) => a.id);

  // Feedback on the button itself: a notice would sit behind the pop-up's backdrop.
  const copy = (button: HTMLElement, text: string, source: HTMLElement): void => {
    const flash = (label: string): void => {
      button.textContent = label;
      window.setTimeout(() => {
        button.textContent = 'Copy';
      }, 2000);
    };
    navigator.clipboard.writeText(text).then(
      () => {
        flash('Copied ✓');
      },
      () => {
        // Select the text so Cmd/Ctrl+C works by hand.
        getSelection()?.selectAllChildren(source);
        flash("Couldn't copy");
      },
    );
  };
  const chatPart = setupConnectChat({
    folder: () => {
      const model = getModelPath();
      return getProjectFolder() ?? (model === undefined ? undefined : folderOf(model));
    },
    copy,
  });

  // The tabs, from the description files.
  const tabs = el('connect-agents');
  for (const a of AGENTS) {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'connect-agent';
    radio.value = a.id;
    label.append(radio, a.tab);
    tabs.append(label);
  }

  const target = (): ConnectTarget => ({
    scope,
    folder: chosenFolder,
    projectFolder: getProjectFolder(),
    modelPath: getModelPath(),
  });

  const refreshPlan = async (id: string, useShell = false): Promise<void> => {
    if (!api) return;
    const ticket = (planTickets.get(id) ?? 0) + 1;
    planTickets.set(id, ticket);
    const plan = await api.planConnect(
      id,
      scopedIds.includes(id) ? target() : { scope: 'user' },
      useShell,
    );
    if (ticket !== planTickets.get(id)) return;
    plans.set(id, plan);
    found.set(id, plan.program);
    renderDialog();
  };

  const render = (): void => {
    const view = aiStatusView(activity, Date.now(), listening);
    item.dataset['dot'] = view.dot;
    label.textContent = view.label;
    item.title = view.title;
    if (dialog.open) renderDialog();
  };

  const renderDialog = (): void => {
    for (const radio of dialog.querySelectorAll<HTMLInputElement>('input[name="connect-agent"]'))
      radio.checked = radio.value === agent;
    const shown = agentOf(agent);
    const sc = scoped();
    el('connect-panel-claude').hidden = !sc;
    el('connect-panel-agent').hidden = sc !== undefined || !shown;
    if (shown && !sc) renderAgent(shown);
    if (sc) renderScoped(sc);
    chatPart.render(shown, setup);
    const missing = el('connect-missing');
    missing.hidden = !setup || (setup.exists && !setup.temporaryLocation);
    missing.textContent = setup?.temporaryLocation
      ? 'Move Third Wheel to your Applications folder and open it from there first: the setup below points to where the app is now.'
      : setup?.packaged
        ? 'The MCP server is missing from this install. Reinstall the app.'
        : 'The MCP server is not built yet: run pnpm build:mcp in the third-wheel folder first.';
    const last = activity.lastCall;
    el('connect-last').textContent =
      activity.bridge === 'failed' || activity.bridge === 'off'
        ? aiStatusView(activity, Date.now()).title
        : last
          ? `Last AI call: ${last.tool} at ${new Date(last.at).toLocaleTimeString()} (${ago(Date.now() - last.at)}).`
          : 'No AI call yet this session.';
  };

  /** The scope panel's texts that follow the switch (agent with the folder switch). */
  const renderScoped = (a: AgentDesc): void => {
    const hint = (scope === 'folder' ? a.texts.scopeFolder : a.texts.scopeUser) ?? '';
    const info = el('connect-scope-hint');
    info.title = hint;
    info.setAttribute('aria-label', hint);
    el('connect-then').textContent =
      scope === 'folder'
        ? `Then start ${a.label} in that folder: /mcp lists third-wheel.`
        : `Then start ${a.label} anywhere: /mcp lists third-wheel.`;
    el('connect-command').textContent =
      setup && a.command ? commandText(a.command, setup, scope) : '…';
    el('connect-json').textContent = (setup ? jsonSnippet(a, setup) : undefined) ?? '…';
    renderOneClick(a);
  };

  /** Panel of an agent without the folder switch. */
  const renderAgent = (a: AgentDesc): void => {
    const id = a.id;
    const view = setup ? agentPanel(a, setup, found.get(id)) : undefined;
    const button = el('connect-agent-button') as HTMLButtonElement;
    el('connect-agent-one-click').hidden = !view?.buttonHint;
    button.hidden = !view?.button;
    const looking = a.engine === 'command' && !found.has(id);
    const result = results.get(id);
    button.disabled =
      looking ||
      connecting !== undefined ||
      confirming !== undefined ||
      !setup?.exists ||
      setup.temporaryLocation;
    button.textContent = looking
      ? `Looking for ${a.label}…`
      : connecting === id
        ? 'Adding…'
        : (view?.button ?? '');
    el('connect-agent-hint').textContent = view?.buttonHint ?? '';
    const line = el('connect-agent-result');
    line.hidden = !result;
    if (result) {
      line.dataset['ok'] = String(result.ok);
      line.textContent = agentResultText(a, result);
    }
    el('connect-agent-shell').hidden = !(
      a.engine === 'command' &&
      found.get(id) === null &&
      setup?.platform !== 'win32'
    );
    renderConfirm('connect-agent', a.engine === 'command' && confirming === id, a);
    // Folded while a button does it; open when copying is the only way.
    if (!view?.button) (el('connect-agent-manual') as HTMLDetailsElement).open = true;
    el('connect-agent-title').textContent = view?.title ?? '';
    el('connect-agent-text').textContent = view?.text ?? '…';
    el('connect-agent-where').textContent = view?.where ?? '';
  };

  /**
   * "Remove the entry in …" per entry in the way (under "Why?"), except the one Connect replaces
   * itself; a click opens a box that says what runs, Remove does it.
   */
  const renderFixes = (a: AgentDesc, plan: ConnectPlan | undefined): void => {
    const platform = setup?.platform ?? '';
    const same = (x: FoundEntry, y: FoundEntry | undefined): boolean =>
      y !== undefined && x.where === y.where && samePath(x.file, y.file, platform);
    const fixes = (plan?.check?.fixes ?? []).filter((e) => !same(e, plan?.replace));
    if (fixing && !fixes.some((e) => same(e, fixing))) fixing = undefined;
    const list = el('connect-fixes');
    list.replaceChildren(
      ...fixes.map((e) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.textContent = removeFixLabel(e, plan?.folder, platform);
        b.disabled = fixing !== undefined || connecting !== undefined;
        b.addEventListener('click', () => {
          fixing = e;
          fixResult = undefined;
          renderDialog();
        });
        return b;
      }),
    );
    el('connect-fix-confirm').hidden = !fixing;
    el('connect-fix-text').textContent = fixing ? removeFixText(fixing, a, plan?.folder) : '';
    const line = el('connect-fix-result');
    line.hidden = !fixResult;
    line.dataset['ok'] = String(fixResult?.ok ?? false);
    line.textContent = fixResult?.text ?? '';
  };

  /** The "about to run" box (`prefix` = its id prefix). */
  const renderConfirm = (prefix: string, show: boolean, a: AgentDesc): void => {
    const box = el(`${prefix}-confirm`);
    const plan = plans.get(a.id);
    box.hidden = !show || !plan;
    if (box.hidden || !plan) return;
    const forScope = hasScopeSwitch(a) ? scope : 'user';
    el(`${prefix}-confirm-lead`).textContent = confirmLead(plan, forScope);
    el(`${prefix}-confirm-text`).textContent = confirmText(plan, forScope, a.label);
    el(`${prefix}-steps`).textContent = plan.steps.join('\n');
    const replace = el(`${prefix}-replace`);
    replace.hidden = !plan.replace;
    replace.textContent = plan.replace ? replaceShort(plan.replace) : '';
    const go = el(`${prefix}-go`) as HTMLButtonElement;
    go.textContent = plan.replace ? 'Replace and add' : 'Add';
    go.disabled = connecting !== undefined || plan.blocked !== undefined || !plan.program;
  };

  const renderOneClick = (a: AgentDesc): void => {
    const id = a.id;
    const plan = plans.get(id);
    const program = found.has(id) ? found.get(id) : undefined;
    const result = results.get(id);
    const button = el('connect-claude') as HTMLButtonElement;
    const hint = el('connect-claude-hint');
    const notFound = program === null;
    el('connect-folder-row').hidden = scope !== 'folder';
    const folder = el('connect-folder');
    folder.textContent = plan?.folder
      ? lastPart(plan.folder)
      : plan
        ? `none yet: choose the one you start ${a.label} in`
        : '…';
    folder.title = plan?.folder ?? '';
    const check = el('connect-check');
    const state = plan?.check?.state;
    el('connect-check-row').hidden = !plan?.check;
    check.dataset['state'] = state ?? 'none';
    check.textContent = plan?.check?.short ?? '';
    check.title = plan?.check?.text ?? '';
    el('connect-why').hidden = state !== 'warn';
    el('connect-check-text').textContent = plan?.check?.text ?? '';
    renderFixes(a, plan);
    button.hidden = notFound;
    // Already set up: still there (add it again), but not the next step any more.
    button.classList.toggle('primary', state !== 'ok');
    button.disabled =
      program === undefined ||
      connecting !== undefined ||
      confirming !== undefined ||
      plan?.blocked !== undefined ||
      !setup?.exists ||
      setup.temporaryLocation;
    button.textContent =
      program === undefined
        ? `Looking for ${a.label}…`
        : connecting === id
          ? 'Adding…'
          : `Add Third Wheel to ${a.label}…`;
    hint.textContent = notFound
      ? `${a.label} wasn’t found in the usual places.`
      : (plan?.blocked ?? '');
    hint.hidden = hint.textContent === '';
    el('connect-shell').hidden = !notFound || setup?.platform === 'win32';
    renderConfirm('connect', confirming === id, a);
    // Not found: setting it up by hand is the way, so it opens.
    if (notFound) (el('connect-manual') as HTMLDetailsElement).open = true;
    const line = el('connect-result');
    line.hidden = !result;
    if (!result) {
      line.textContent = ''; // no stale "Added ✓" while the next one runs
      return;
    }
    const problem = result.ok && result.check?.state !== 'ok' ? result.check : undefined;
    line.dataset['ok'] = problem ? 'warn' : String(result.ok);
    line.textContent = result.ok
      ? problem
        ? `Added, but it won’t work yet: see “Why?” above.`
        : `Added ✓${a.texts.after ? ` ${a.texts.after}` : ''}`
      : result.reason === 'failed'
        ? `Couldn’t add it${result.detail ? `: ${result.detail}` : '.'} Try “Set it up yourself” below.`
        : result.reason === 'not-found'
          ? `${a.label} wasn’t found. Try “Set it up yourself” below.`
          : result.reason === 'exists'
            ? 'There already is an entry here: check the box and click again to replace it.'
            : result.reason === 'changed'
              ? `${a.label} was found in another place now: check the box and click again.`
              : 'Move Third Wheel to your Applications folder and open it from there first.';
  };

  dialog.addEventListener('keydown', (e) => {
    if (dialog.open) e.stopPropagation(); // tool shortcuts must not fire behind it (closed: may still hold focus)
  });
  for (const radio of dialog.querySelectorAll<HTMLInputElement>('input[name="connect-agent"]'))
    radio.addEventListener('change', () => {
      if (!radio.checked || !agentOf(radio.value)) return;
      agent = radio.value;
      try {
        localStorage.setItem(AGENT_KEY, agent);
      } catch {
        // Not remembered.
      }
      renderDialog();
    });
  for (const radio of dialog.querySelectorAll<HTMLInputElement>('input[name="connect-scope"]'))
    radio.addEventListener('change', () => {
      if (radio.checked) scope = radio.value === 'user' ? 'user' : 'folder';
      confirming = undefined;
      for (const id of scopedIds) results.delete(id);
      renderDialog();
      for (const id of scopedIds) void refreshPlan(id);
    });
  const copyCommand = el('connect-copy-command');
  copyCommand.addEventListener('click', () => {
    const a = scoped();
    if (setup && a?.command)
      copy(copyCommand, commandText(a.command, setup, scope), el('connect-command'));
  });
  const copyJson = el('connect-copy-json');
  copyJson.addEventListener('click', () => {
    const a = scoped();
    const json = a && setup ? jsonSnippet(a, setup) : undefined;
    if (json) copy(copyJson, json, el('connect-json'));
  });

  const copyAgent = el('connect-copy-agent');
  copyAgent.addEventListener('click', () => {
    const a = agentOf(agent);
    if (setup && a && !hasScopeSwitch(a))
      copy(copyAgent, agentPanel(a, setup, found.get(a.id)).text, el('connect-agent-text'));
  });

  /** Run the one-click (after the "about to run" box for a command agent). */
  const connect = (id: string, replace = false): void => {
    if (!api || connecting) return;
    const isCommand = agentOf(id)?.engine === 'command';
    connecting = id;
    results.delete(id);
    renderDialog();
    // Exactly the folder the box showed: an agent may have opened another model since.
    const shown = plans.get(id)?.folder;
    // … and exactly the program it showed.
    const program = plans.get(id)?.program ?? undefined;
    const to: ConnectTarget = scopedIds.includes(id)
      ? { ...target(), ...(shown === undefined ? {} : { folder: shown }), program, replace }
      : { scope: 'user', program, replace };
    void api
      .connectAgent(id, to)
      .catch((e: unknown): ConnectResult => ({ ok: false, reason: 'failed', detail: String(e) }))
      .then(async (r) => {
        connecting = undefined;
        if (r.ok || (r.reason !== 'exists' && r.reason !== 'changed')) confirming = undefined;
        results.set(id, r);
        if (r.ok && isCommand) found.set(id, r.path);
        else if (!r.ok && r.reason === 'not-found' && isCommand) found.set(id, null);
        renderDialog();
        if (isCommand) await refreshPlan(id);
      });
  };
  /** First click: fresh plan, then the box; nothing runs yet. */
  const showPlan = (id: string): void => {
    results.delete(id);
    void refreshPlan(id).then(() => {
      confirming = id;
      renderDialog();
      el(scopedIds.includes(id) ? 'connect-go' : 'connect-agent-go').focus();
    });
  };
  el('connect-claude').addEventListener('click', () => {
    const a = scoped();
    if (a) showPlan(a.id);
  });
  el('connect-agent-button').addEventListener('click', () => {
    if (agentOf(agent)?.engine === 'command') showPlan(agent);
    else connect(agent);
  });
  for (const prefix of ['connect', 'connect-agent'] as const) {
    el(`${prefix}-go`).addEventListener('click', () => {
      if (confirming) connect(confirming, plans.get(confirming)?.replace !== undefined);
    });
    el(`${prefix}-cancel`).addEventListener('click', () => {
      confirming = undefined;
      renderDialog();
    });
    el(`${prefix}-look-shell`).addEventListener('click', (e) => {
      const button = e.currentTarget as HTMLButtonElement;
      button.disabled = true;
      const id = prefix === 'connect' ? scoped()?.id : agent;
      if (!id) {
        button.disabled = false;
        return;
      }
      void refreshPlan(id, true).finally(() => {
        button.disabled = false;
      });
    });
  }
  el('connect-fix-cancel').addEventListener('click', () => {
    fixing = undefined;
    renderDialog();
  });
  el('connect-fix-go').addEventListener('click', (e) => {
    const a = scoped();
    const which = fixing;
    if (!api || !a || !which) return;
    const button = e.currentTarget as HTMLButtonElement;
    button.disabled = true;
    const shown = plans.get(a.id);
    const to: ConnectTarget = {
      ...target(),
      ...(shown?.folder === undefined ? {} : { folder: shown.folder }),
      program: shown?.program ?? undefined,
    };
    void api
      .removeEntry(a.id, to, { where: which.where, file: which.file })
      .catch((err: unknown) => ({ ok: false as const, detail: String(err) }))
      .then(async (r) => {
        fixing = undefined;
        fixResult = r.ok
          ? { ok: true, text: 'Removed ✓' }
          : { ok: false, text: `Couldn’t remove it: ${r.detail}` };
        await refreshPlan(a.id);
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  el('connect-choose-folder').addEventListener('click', () => {
    const id = scoped()?.id;
    if (!id) return;
    void api?.chooseFolder(plans.get(id)?.folder).then((folder) => {
      if (folder === null) return;
      chosenFolder = folder;
      confirming = undefined;
      for (const s of scopedIds) results.delete(s);
      for (const s of scopedIds) void refreshPlan(s);
    });
  });

  const open = (at?: 'chat'): void => {
    if (!dialog.open) {
      results.clear();
      confirming = undefined;
      fixing = undefined;
      fixResult = undefined;
      chosenFolder = undefined; // the shown model may have changed
      chatPart.opened();
    }
    renderDialog();
    if (!dialog.open) dialog.showModal();
    if (at === 'chat') el('connect-chat').scrollIntoView({ block: 'nearest' });
    for (const a of AGENTS)
      if (hasScopeSwitch(a)) void refreshPlan(a.id);
      else if (a.engine === 'command' || a.engine === 'settings')
        void api?.findAgent(a.id).then((path) => {
          found.set(a.id, path);
          renderDialog();
        });
    // Ask again each time: the server may have been built since.
    void api?.getMcpSetup().then((s) => {
      setup = s;
      renderDialog();
    });
  };
  item.addEventListener('click', () => {
    open();
  });

  if (api) {
    api.onAiActivity((a) => {
      activity = a;
      render();
    });
    void api.getAiActivity().then((a) => {
      activity = a;
      render();
    });
  }
  render();
  window.setInterval(render, REFRESH_MS);

  return {
    open,
    activity: () => activity,
    setChatStatus: (status) => {
      chatPart.setStatus(status);
      const on = status.state === 'listening';
      if (on === listening) return;
      listening = on;
      render();
    },
  };
}
