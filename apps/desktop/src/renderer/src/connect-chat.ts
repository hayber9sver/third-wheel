/**
 * The Connect pop-up's "Chat in Third Wheel" part (for agents whose description has `chat`): the
 * terminal line that starts the agent in the project folder, the start phrase, the live status
 * (waiting → connected → listening), and the folded "Ask fewer permission questions" (shows the
 * exact lines, writes only on the button). Texts: `shared/chat-setup.ts`.
 */
import type { AgentDesc } from '../../shared/agent-desc.js';
import type { McpSetup } from '../../shared/ai-status.js';
import type { ChatStatus } from '../../shared/chat.js';
import {
  allowPreview,
  chatSetupLine,
  DEFAULT_CAD_COMMAND,
  startCommand,
  type AllowPlan,
} from '../../shared/chat-setup.js';
import { lastPart } from '../../shared/claude-setup.js';
import { LISTEN_COMMAND } from './chat-display.js';

const CAD_KEY = 'connect-cad-command';
const PLAN_DELAY_MS = 300;

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e;
}

export interface ConnectChatOptions {
  /** The folder the agent should start in (the project's); undefined: none open. */
  readonly folder: () => string | undefined;
  /** Copy with feedback on the button. */
  readonly copy: (button: HTMLElement, text: string, source: HTMLElement) => void;
}

export interface ConnectChat {
  /** Draw it for the shown agent (hidden when it has no chat part). */
  render(agent: AgentDesc | undefined, setup: McpSetup | undefined): void;
  /** The pop-up opened: read the settings file again. */
  opened(): void;
  /** The chat's agent state (from the Agent tab). */
  setStatus(status: ChatStatus): void;
}

export function setupConnectChat(o: ConnectChatOptions): ConnectChat {
  const api = window.thirdWheel;
  const section = el('connect-chat');
  const cadInput = el('connect-allow-cad') as HTMLInputElement;
  const goButton = el('connect-allow-go') as HTMLButtonElement;
  const result = el('connect-allow-result');
  let status: Pick<ChatStatus, 'state' | 'started'> = { state: 'none' };
  let agent: AgentDesc | undefined;
  let setup: McpSetup | undefined;
  /** The last preview, for the agent + folder + command it was made for. */
  let plan: { key: string; plan: AllowPlan } | undefined;
  let ticket = 0;
  let timer: number | undefined;
  let writing = false;
  /** The folder the last `render` saw: a new one reads the settings file again. */
  let shownFolder: string | undefined;

  try {
    cadInput.value = localStorage.getItem(CAD_KEY) ?? DEFAULT_CAD_COMMAND;
  } catch {
    cadInput.value = DEFAULT_CAD_COMMAND;
  }

  const keyOf = (a: AgentDesc, folder: string): string => `${a.id}\n${folder}\n${cadInput.value}`;

  const refreshPlan = (): void => {
    const a = agent;
    const folder = o.folder();
    if (!api || !a?.chat?.allow || folder === undefined) return;
    const t = ++ticket;
    const key = keyOf(a, folder);
    void api.planAllow(a.id, folder, cadInput.value).then((p) => {
      if (t !== ticket) return;
      plan = { key, plan: p };
      draw();
    });
  };

  const draw = (): void => {
    const a = agent;
    const chat = a?.chat;
    section.hidden = !chat;
    if (!a || !chat) return;
    const folder = o.folder();
    const platform = setup?.platform ?? '';
    el('connect-chat-start-lead').textContent =
      folder === undefined
        ? `Open a project folder in Third Wheel first, then start ${a.label} in it.`
        : `Start ${a.label} in the project folder “${lastPart(folder)}” (${platform === 'win32' ? 'in PowerShell' : 'in a terminal'}):`;
    el('connect-chat-start-box').hidden = folder === undefined;
    el('connect-chat-start').textContent =
      folder === undefined ? '' : startCommand(chat.start, folder, platform);
    el('connect-chat-phrase').textContent = LISTEN_COMMAND;
    const line = chatSetupLine(status, folder, a.label, platform);
    const statusLine = el('connect-chat-status');
    statusLine.dataset['state'] = line.state;
    statusLine.textContent = line.text;
    const warn = el('connect-chat-warn');
    warn.hidden = line.warn === undefined;
    warn.textContent = line.warn ?? '';

    const allow = chat.allow;
    el('connect-allow').hidden = !allow;
    if (!allow) return;
    const fileName = allow.file.split('/').at(-1) ?? allow.file;
    el('connect-allow-lead').textContent =
      `${a.label} asks before each Third Wheel tool and each run of your CAD command. Allow them for this folder:`;
    const current =
      folder === undefined ? undefined : plan?.key === keyOf(a, folder) ? plan.plan : undefined;
    const preview = el('connect-allow-preview');
    const ready = current !== undefined && current.error === undefined;
    preview.textContent =
      folder === undefined
        ? 'Open a project folder first.'
        : !current
          ? '…'
          : current.error !== undefined
            ? ''
            : current.add.length === 0
              ? `Already allowed in ${allow.file} ✓`
              : allowPreview(allow.file, folder, current.exists, current.add);
    preview.title = current?.file ?? '';
    el('connect-allow-note').textContent =
      `Only for you, in this folder: ${fileName} is ${a.label}’s personal settings file (not meant for git). Other settings in it stay; the old file is kept as ${fileName}.bak. Restart ${a.label} if it’s running.`;
    goButton.hidden = ready && current.add.length === 0;
    goButton.disabled = !ready || writing;
    if (current?.error !== undefined) {
      result.hidden = false;
      result.dataset['ok'] = 'false';
      result.textContent = current.error;
    } else if (result.dataset['ok'] === 'false' && !writing) result.hidden = true;
  };

  cadInput.addEventListener('input', () => {
    try {
      localStorage.setItem(CAD_KEY, cadInput.value);
    } catch {
      // Not remembered.
    }
    result.hidden = true;
    window.clearTimeout(timer);
    timer = window.setTimeout(refreshPlan, PLAN_DELAY_MS);
    draw();
  });
  goButton.addEventListener('click', () => {
    const a = agent;
    const folder = o.folder();
    const p =
      folder === undefined || !a
        ? undefined
        : plan?.key === keyOf(a, folder)
          ? plan.plan
          : undefined;
    if (!api || !a || folder === undefined || !p || p.error !== undefined || writing) return;
    writing = true;
    draw();
    void api
      .writeAllow(a.id, folder, cadInput.value, p.add)
      .then((r) => {
        result.hidden = false;
        result.dataset['ok'] = String(r.ok);
        result.textContent = r.ok
          ? `Added ${String(r.added.length)} line${r.added.length === 1 ? '' : 's'} to ${r.file} ✓`
          : r.error;
      })
      .finally(() => {
        writing = false;
        refreshPlan();
      });
  });
  const copyStart = el('connect-chat-copy-start');
  copyStart.addEventListener('click', () => {
    const text = el('connect-chat-start').textContent;
    if (text) o.copy(copyStart, text, el('connect-chat-start'));
  });
  const copyPhrase = el('connect-chat-copy-phrase');
  copyPhrase.addEventListener('click', () => {
    o.copy(copyPhrase, LISTEN_COMMAND, el('connect-chat-phrase'));
  });

  return {
    render(a, s) {
      const folder = o.folder();
      const changed = a?.id !== agent?.id || folder !== shownFolder;
      agent = a;
      setup = s;
      shownFolder = folder;
      draw();
      if (changed) refreshPlan();
    },
    opened() {
      result.hidden = true;
      refreshPlan();
    },
    setStatus(next) {
      status = next;
      if (section.isConnected) draw();
    },
  };
}
