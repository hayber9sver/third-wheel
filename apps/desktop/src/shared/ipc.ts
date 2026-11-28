import type {
  AiActivity,
  ConnectPlan,
  ConnectResult,
  ConnectTarget,
  McpSetup,
} from './ai-status.js';
import type { ChatEntry, ChatEvent, ChatListItem, ChatPage, ChatPost, ChatView } from './chat.js';
import type { AllowPlan, AllowResult } from './chat-setup.js';
import type { EntryRef, RemoveResult } from './claude-setup.js';
import type { ThemeMode } from './theme.js';
import type { MenuCommand } from './menu-commands.js';
import type { FeedbackPlace, SystemInfo } from './feedback.js';

/** IPC channel names. */
export const IPC = {
  /** renderer → main */
  setThemeSource: 'theme:set-source',
  /** renderer → main (invoke): show the Open dialog, resolve with the file or null. */
  openModelDialog: 'model:open-dialog',
  /**
   * renderer → main (invoke): read an already opened model file again (exact values after its
   * kernel was freed). Only paths main handed out before.
   */
  rereadModelFile: 'model:reread',
  /** renderer → main (invoke): an opened model's version in its project (notes, made from, newer). */
  openVersion: 'project:open-version',
  /** renderer → main (invoke): other versions of an opened model in its folder. */
  listModelVersions: 'model:versions',
  /** renderer → main (invoke): content hash (or missing) of version files on disk. */
  versionFileStates: 'model:version-states',
  /** renderer → main (invoke): the shown model becomes a version made from another one. */
  linkProjectVersion: 'project:link-version',
  /** renderer → main (invoke): whether one version was made (directly or further back) into another. */
  isEarlierVersion: 'project:is-earlier',
  /** renderer → main (invoke): list an added model as a separate part of the project at once. */
  addProjectPart: 'project:add-part',
  /** renderer → main (invoke): the project folder + part id of an opened model's contents. */
  projectPartOf: 'project:part-of',
  /** renderer → main (invoke): all versions of the shown model's part, from the project. */
  projectVersions: 'project:versions',
  /** renderer → main (invoke): Parts ▾, the shown project's parts with their newest versions. */
  projectParts: 'project:parts',
  /** renderer → main (invoke): Remove from versions… on the project; resolves with the shown chain. */
  removeProjectVersion: 'project:remove-version',
  /** renderer → main (invoke): Locate… on the project; resolves with the shown chain. */
  locateProjectVersion: 'project:locate-version',
  /** renderer → main (invoke): write the annotation sidecar of an opened model. */
  saveSidecar: 'sidecar:save',
  /** renderer → main (sync): same, blocking — the last save while the window closes. */
  saveSidecarSync: 'sidecar:save-sync',
  /** renderer → main (invoke): rename an unusable sidecar to a backup; resolves with its file name. */
  backupSidecar: 'sidecar:backup',
  replaceVersionContents: 'project:replace-contents',
  projectFolders: 'project:folders',
  /** renderer → main (invoke): this model is shown now; resolves with its project's state. */
  projectShown: 'project:shown',
  /** main → renderer: the shown project's state changed (title, read-only). */
  projectState: 'project:state',
  /** main → renderer: a message about the project (notes moved in, read-only, sync copies). */
  projectNotice: 'project:notice',
  /** renderer → main (invoke): File ▸ Make this folder its own project… for the shown model. */
  newProjectHere: 'project:new-here',
  /** renderer → main (invoke): File ▸ Save project as… (main asks for the folder). */
  saveProjectAs: 'project:save-as',
  /** renderer → main (invoke): File ▸ New project folder… (main asks for the folder). */
  newProjectFolder: 'project:new-folder',
  /** main → renderer: show this folder's project with no model (Open folder… found none). */
  emptyProject: 'project:empty',
  /** renderer → main (invoke): make the folder main offered (`emptyProject`) the current project. */
  openEmptyProject: 'project:open-empty',
  /** renderer → main (invoke): the start page's data (recent projects, a project with no model). */
  startState: 'project:start-state',
  /** renderer → main (invoke): open a project from the start page's Recent list. */
  openRecentProject: 'project:open-recent',
  /** renderer → main (invoke): File ▸ Open folder… from the start page. */
  openFolderDialog: 'project:open-folder',
  /** renderer → main (invoke): File ▸ Add file… (picker in the project folder + where it stands). */
  addModelDialog: 'project:add-model',
  /** main → renderer: a model file to load (e.g. from `THIRD_WHEEL_OPEN`). */
  modelFile: 'model:file',
  /** renderer → main (dev, `THIRD_WHEEL_PERF=bench`): benchmark result; main adds memory, prints, quits. */
  perfResult: 'perf:result',
  /** main → renderer: an app-bridge request for the window, `BridgeRendererRequest`. */
  bridgeRequest: 'bridge:request',
  /** renderer → main: its answer, `BridgeRendererReply`. */
  bridgeReply: 'bridge:reply',
  /** renderer → main (invoke): bridge state + last MCP tool call, `AiActivity`. */
  getAiActivity: 'ai:activity',
  /** main → renderer: the same, whenever it changes. */
  aiActivity: 'ai:activity-changed',
  /** renderer → main (invoke): where the MCP server is, `McpSetup`. */
  getMcpSetup: 'ai:mcp-setup',
  /**
   * renderer → main (invoke, agent id): what an agent's one-click button needs — a command
   * agent's program, a settings agent's file; null when not found.
   */
  findAgent: 'ai:find-agent',
  /**
   * renderer → main (invoke, agent id, `ConnectTarget`): run the agent's one-click Connect,
   * `ConnectResult`.
   */
  connectAgent: 'ai:connect-agent',
  /**
   * renderer → main (invoke, command agent's id, `ConnectTarget`, look in the login shell):
   * what Connect would run, `ConnectPlan`; reads files only.
   */
  planConnect: 'ai:plan-connect',
  /** renderer → main (invoke, start folder): folder picker for "This folder only"; null = cancelled. */
  chooseFolder: 'ai:choose-folder',
  /** renderer → main (invoke, agent id, folder, CAD command): what "Allow these" would add, `AllowPlan`. */
  planAllow: 'ai:plan-allow',
  /** renderer → main (invoke, agent id, folder, CAD command, the rules shown): add them, `AllowResult`. */
  writeAllow: 'ai:write-allow',
  /** renderer → main (invoke, agent id, `ConnectTarget`, `EntryRef`): remove an entry the check offered, `RemoveResult`. */
  removeEntry: 'ai:remove-entry',
  /** renderer → main (invoke, text): the user's chat message → the new `ChatEntry`, or null if refused. */
  chatSend: 'chat:send',
  /** renderer → main (invoke, `ChatPost`): thread reply / sent review / agent's reply line → the new `ChatEntry`, or null. */
  chatPost: 'chat:post',
  /** renderer → main (invoke): the conversation so far + the agent's state, `ChatView`. */
  chatView: 'chat:view',
  /** main → renderer: `ChatEvent` (new entry, agent state / queue changed, another chat shown). */
  chatEvent: 'chat:event',
  /** renderer → main (invoke): the shown project's chats, newest first, `ChatListItem[]`. */
  chatList: 'chat:list',
  /** renderer → main (invoke, chat id, before seq?): lines of a saved chat, `ChatPage`. */
  chatRead: 'chat:read',
  /** renderer → main (invoke): "+ New chat" → true, or false when the shown chat is empty. */
  chatNew: 'chat:new',
  /** main → renderer: the About menu item was chosen. */
  showAbout: 'about:show',
  /** renderer → main (invoke): the app version, `app.getVersion()`. */
  getAppVersion: 'about:version',
  /** renderer → main (invoke): text of the shipped third-party notices file. */
  getThirdPartyNotices: 'about:notices',
  /** renderer → main (invoke): OS name / version / CPU for the feedback setup line, `SystemInfo`. */
  getSystemInfo: 'feedback:system',
  /** renderer → main (invoke): open a new GitHub issue or the feedback form in the browser. */
  openFeedback: 'feedback:open',
  /** main → renderer: an app menu item the window carries out, `MenuCommand`. */
  menuCommand: 'menu:command',
  /** renderer → main (send): undo / redo typing in the focused text field (menu). */
  textUndoRedo: 'menu:text-undo-redo',
} as const;

/** A bridge request main hands to the window (methods the window answers, e.g. `status`). */
export interface BridgeRendererRequest {
  readonly requestId: number;
  readonly method: string;
  readonly params: unknown;
}

/** The window's answer to a `BridgeRendererRequest`. */
export type BridgeRendererReply =
  | { readonly requestId: number; readonly ok: true; readonly result: unknown }
  | { readonly requestId: number; readonly ok: false; readonly message: string };

/** Dev perf mode from `THIRD_WHEEL_PERF`, passed to the renderer as the `perf` URL query. */
export type PerfMode = 'off' | 'live' | 'bench';

export function perfModeFromEnv(value: string | undefined): PerfMode {
  if (value === 'bench') return 'bench';
  return value && value !== '0' ? 'live' : 'off';
}

/** A model file read by the main process (the sandboxed renderer can't read files). */
export interface ModelFile {
  /** Absolute path (sidecar goes next to it). */
  readonly path: string;
  /** File name for display. */
  readonly name: string;
  readonly data: ArrayBuffer;
  /** `sha256:<hex>` of the file's bytes (sidecar check). */
  readonly contentHash: string;
}

/** Bridge `load` to the window: the file, and the modelId it is a new version of. */
export interface LoadRequest extends ModelFile {
  readonly revisionOf?: string;
  /** A free path for the next export, next to this file (main checked the project). */
  readonly saveNextAs?: string;
}

/** A STEP file next to an opened model whose name makes it a version of it. */
export interface ModelVersionFile {
  readonly path: string;
  readonly name: string;
  /** Modification time of its sidecar (ms since 1970), when it has one. */
  readonly sidecarMtimeMs?: number;
}

/** A version-chain file on disk now: its content hash, or null when it isn't there. */
export interface VersionFileState {
  readonly path: string;
  readonly contentHash: string | null;
}

/** One version of the shown part (Versions ▾), from the project's list. */
export interface ProjectVersionRow {
  readonly id: string;
  /** Its file on this computer. */
  readonly path: string;
  readonly name: string;
  readonly contentHash: string;
  /** When it was added (ISO). */
  readonly added: string;
  /** The version it was made from (an id in the same list). */
  readonly from?: string;
  /** A newer version was saved over its file: these contents are gone from disk. */
  readonly overwritten?: true;
  readonly shown: boolean;
  /** Content hash of the file at `path` now; null = not there. */
  readonly onDisk: string | null;
}

/** One part of the shown project (Parts ▾), with its newest version. */
export interface ProjectPartRow {
  readonly partId: string;
  readonly name: string;
  /** Its newest version's file on this computer (what opening the part shows). */
  readonly path: string;
  /** That file's name. */
  readonly fileName: string;
  readonly contentHash: string;
  readonly openComments: number;
  /** The shown model's part. */
  readonly shown: boolean;
  /** Content hash of the file at `path` now; null = not there. */
  readonly onDisk: string | null;
}

/** Another version of a part, as the project lists it. */
export interface VersionInfo {
  /** Its file on this computer. */
  readonly path: string;
  readonly name: string;
  readonly contentHash: string;
  /** The project has notes for it (its paint, or its part's comments). */
  readonly hasNotes: boolean;
}

/** A model file's version as the project knows it (`openVersion`). */
export interface OpenedVersion {
  /** Its notes (window shape, sidecar JSON); null = none yet. */
  readonly notes: string | null;
  /** The project lists these contents at this path. */
  readonly listed: boolean;
  /** It has paint of its own (a marks file). */
  readonly hasMarks: boolean;
  /** The user took it out of its versions (left out of "new version?" guesses). */
  readonly unlinked?: true;
  /** The version it was made from. */
  readonly parent?: VersionInfo;
  /** The newest version made from it. */
  readonly newer?: VersionInfo;
  /** Not listed with these contents, but the file is, with others: it was saved over since. */
  readonly replaced?: VersionInfo;
  /** The project's markers (all parts / versions): their names are taken. The window counts the ones it lists as its own. */
  readonly otherMarkers?: readonly { readonly id: string; readonly name: string }[];
}

/** How `linkProjectVersion` went. */
export type LinkResult =
  | {
      readonly kind: 'linked';
      readonly before?: VersionInfo;
      /** Comments of the part lost links to files now in it (a comment links to other parts only). */
      readonly removedLinks?: { readonly count: number; readonly partName: string };
    }
  | { readonly kind: 'already' }
  | { readonly kind: 'circle' };

/** All versions of the shown part, newest first. */
export interface ProjectVersions {
  readonly partName: string;
  readonly rows: readonly ProjectVersionRow[];
}

/** Result of a sidecar write. */
/** `backup` = file name of the copy made first (when asked to back up before writing). */
export type SaveResult =
  | {
      readonly ok: true;
      readonly backup?: string;
      /** Kept in memory only: the project is read-only (why). */
      readonly readOnly?: string;
    }
  | { readonly ok: false; readonly error: string };

/** The project of the shown model (window title, read-only bar). */
export interface ProjectState {
  /** Project name (default: its folder's name). */
  readonly name: string;
  /** The project folder (holds `.thirdwheel/`). */
  readonly folder: string;
  /** `.thirdwheel/project.json` exists (else made on the first change). */
  readonly exists: boolean;
  /** Changes are not saved: why. */
  readonly readOnly?: string;
}

/** One row of the start page's Recent projects. */
export interface RecentProjectRow {
  readonly name: string;
  readonly folder: string;
  /** The folder as shown (`~/…` under the home folder). */
  readonly folderLabel: string;
  /** When it was last opened (ISO), if known. */
  readonly opened?: string;
}

/** What the start page shows. */
export interface StartState {
  readonly recent: readonly RecentProjectRow[];
  /** A project open with no model shown yet (New project folder…, an empty folder). */
  readonly project?: ProjectState;
}

/** File ▸ Add file…: the picked file and where it stands relative to the open project. */
export type AddModelPick =
  | {
      readonly file: ModelFile;
      readonly place: 'inside';
      readonly listed: boolean;
      /**
       * Not listed: the newest version (on disk, unchanged) of a part whose name it matches
       * (`bracket_v2` ↔ `bracket`) — Add file… with no model shown asks about it.
       */
      readonly versionOf?: VersionInfo;
    }
  | { readonly file: ModelFile; readonly place: 'other'; readonly project: ProjectState }
  | { readonly file: ModelFile; readonly place: 'outside'; readonly project?: ProjectState };

/** API exposed on `window.thirdWheel` by the preload script. */
export interface ThirdWheelApi {
  /** Sync Electron's native theme (title bar, `prefers-color-scheme`) with the user's choice. */
  setThemeSource(mode: ThemeMode): void;
  /** Show the native Open dialog for STEP files (`title`: its title); null if cancelled. */
  /** `shownPath`: the shown model; the dialog starts in its folder. */
  openModelDialog(title?: string, shownPath?: string): Promise<ModelFile | null>;
  /**
   * Read a model file opened before, or one listed by `listModelVersions`, again (rejects for
   * any other path). A listed version is opened (its sidecar writable) only with `open` (
   * read only to compare otherwise).
   */
  rereadModelFile(path: string, open?: boolean): Promise<ModelFile>;
  /**
   * The version of an opened model in its project: its notes, what it was made from, the newest
   * made from it. Read only after the previous model's last save, so reopening the same file never
   * sees an old copy. `contentHash`: the file's contents (a file put back to an older version's
   * contents gets that version); without it, the version the path stands for now.
   */
  openVersion(modelPath: string, contentHash?: string): Promise<OpenedVersion>;
  /**
   * STEP files in an opened model's folder whose names make them versions of it (`part.step`,
   * `part_v2.step`, `part (2).step`). Their notes can then be read with `openVersion`.
   */
  listModelVersions(modelPath: string): Promise<ModelVersionFile[]>;
  /**
   * The content hash of each file named in the shown model's version chain (null = not
   * found). At most 200; found ones can then be read with `rereadModelFile` and `openVersion`.
   */
  versionFileStates(paths: readonly string[]): Promise<VersionFileState[]>;
  /**
   * `path` (an opened model, these contents) becomes a version made from `parent` (listed in the
   * project, or an opened model). Rejects on failure.
   */
  linkProjectVersion(
    path: string,
    contentHash: string,
    parent: { readonly path: string; readonly contentHash: string },
  ): Promise<LinkResult>;
  /**
   * The shown file was saved over in place (one file name = one version): its listed version with
   * `oldHash` gets the new contents. Its paint stays until the window saves the paint it moved
   * onto the new geometry (or moves it aside with `backupSidecar`).
   */
  replaceVersionContents(path: string, oldHash: string, newHash: string): Promise<void>;
  /**
   * The project folder of each opened model / listed version (`''` = not one the window may
   * ask about). A model never becomes a version of one in another project.
   */
  projectFolders(paths: readonly string[]): Promise<string[]>;
  /** `maybe` is `of` or one of the versions `of` was made from (both by path + contents). */
  isEarlierVersion(
    maybe: { readonly path: string; readonly contentHash: string },
    of: { readonly path: string; readonly contentHash: string },
  ): Promise<boolean>;
  /**
   * Add file… → Separate part (or the first model of an empty project): list the opened model
   * `path` in the project at once, as a part of its own. Nothing when it is listed already.
   */
  addProjectPart(path: string): Promise<void>;
  /**
   * The project folder and part id of the opened model `path` with `contentHash`; null when the
   * project doesn't list it yet (nothing saved for it so far).
   */
  projectPartOf(
    path: string,
    contentHash: string,
  ): Promise<{ readonly folder: string; readonly partId: string } | null>;
  /**
   * Versions ▾: all versions of the part of the shown model (`path` with `contentHash`), newest
   * first, each checked on disk; null when the project doesn't list it yet. Found files can then
   * be read with `rereadModelFile`.
   */
  projectVersions(path: string, contentHash: string): Promise<ProjectVersions | null>;
  /**
   * Parts ▾: the shown project's parts in the order added, each with its newest version checked
   * on disk; `shown` (the shown model) marks its part. Empty with no project.
   */
  projectParts(shown?: {
    readonly path: string;
    readonly contentHash: string;
  }): Promise<readonly ProjectPartRow[]>;
  /**
   * Remove from versions…: `versionId` (another version of the shown part) leaves the part.
   */
  removeProjectVersion(path: string, contentHash: string, versionId: string): Promise<void>;
  /** Locate…: `versionId`'s file is now `moved` (a file the user picked). */
  locateProjectVersion(
    path: string,
    contentHash: string,
    versionId: string,
    moved: string,
  ): Promise<void>;
  /**
   * Write `<model>.thirdwheel.json` next to an opened model (`modelPath`). `backupFirst`: copy the
   * existing file to a `.bak.json` first (a load dropped data); the write fails if the copy does.
   */
  saveSidecar(modelPath: string, text: string, backupFirst?: boolean): Promise<SaveResult>;
  /** Same, blocking (used while the window closes). */
  saveSidecarSync(modelPath: string, text: string, backupFirst?: boolean): SaveResult;
  /** Its notes can't be used: the version's marks file is moved aside; its file name, or null if none. */
  backupSidecar(modelPath: string, contentHash: string): Promise<string | null>;
  /** The window shows this model now: its project becomes the current one (lock, title). */
  projectShown(modelPath: string): Promise<ProjectState>;
  onProjectState(listener: (state: ProjectState | undefined) => void): void;
  onProjectNotice(listener: (text: string) => void): void;
  /** New project in the shown model's folder (asks first); null = cancelled. */
  newProjectHere(modelPath: string): Promise<ProjectState | null>;
  /** Copy the shown project to a folder the user picks; null = cancelled. Rejects on failure. */
  saveProjectAs(modelPath: string): Promise<ProjectState | null>;
  /** File ▸ New project folder…: main asks for the folder; null = cancelled or nothing to show. */
  newProjectFolder(): Promise<
    { readonly state: ProjectState } | { readonly alreadyOpen: string } | null
  >;
  /** Main found no model to show in a folder (Open folder…): `folder` is offered to `openEmptyProject`. */
  onEmptyProject(listener: (folder: string) => void): void;
  openEmptyProject(folder: string): Promise<ProjectState>;
  startState(): Promise<StartState>;
  openRecentProject(folder: string): Promise<void>;
  openFolderDialog(): Promise<void>;
  /** File ▸ Add file…: picker inside the project folder; null = cancelled. */
  addModelDialog(): Promise<AddModelPick | null>;
  /** Called when the main process pushes a model to open. */
  onModelFile(listener: (file: ModelFile) => void): void;
  /** Dev perf benchmark: hand the result to the main process (which prints it and quits). */
  sendPerfResult(result: unknown): void;
  /**
   * Answer app-bridge requests for the window: `handler` resolves with the result or
   * rejects with a message. Set once.
   */
  onBridgeRequest(handler: (method: string, params: unknown) => unknown): void;
  /** Bridge state and the last MCP tool call. */
  getAiActivity(): Promise<AiActivity>;
  /** Called whenever the bridge state or the last tool call changes. Set once. */
  onAiActivity(handler: (activity: AiActivity) => void): void;
  /** Where the MCP server file is, for the "Set up your AI agent" pop-up. */
  getMcpSetup(): Promise<McpSetup>;
  /** What the agent's one-click button uses (program, settings file, link); null = not found. */
  findAgent(agent: string): Promise<string | null>;
  /** One-click Connect for an agent (`target`: scope, folder, replace). */
  connectAgent(agent: string, target?: ConnectTarget): Promise<ConnectResult>;
  /** What a command agent's Connect would run; `useShell` also asks the login shell. */
  planConnect(agent: string, target: ConnectTarget, useShell?: boolean): Promise<ConnectPlan>;
  /** Folder picker for "This folder only"; null = cancelled. */
  chooseFolder(startIn?: string): Promise<string | null>;
  /** What "Ask fewer permission questions" would add to the agent's settings file in `folder`. */
  planAllow(agent: string, folder: string, cad: string): Promise<AllowPlan>;
  /** Add the rules the preview showed (`shown`). */
  writeAllow(
    agent: string,
    folder: string,
    cad: string,
    shown: readonly string[],
  ): Promise<AllowResult>;
  /** Remove a Third Wheel entry the check offered to remove. */
  removeEntry(agent: string, target: ConnectTarget, which: EntryRef): Promise<RemoveResult>;
  /** Called when the About menu item is chosen. Set once. */
  onShowAbout(handler: () => void): void;
  /** Called when an app menu item the window carries out is chosen. Set once. */
  onMenuCommand(handler: (command: MenuCommand) => void): void;
  /** Undo / redo typing in the focused text field (`webContents.undo()` / `redo()`). */
  textUndoRedo(which: 'undo' | 'redo'): void;
  /** Send a chat message to the agent (queued until it listens); null when refused (empty, too long). */
  chatSend(text: string): Promise<ChatEntry | null>;
  /**
   * Add a thread reply or a sent review (both go to the agent; null when no chat agent connected
   * this session) or the agent's reply under a comment (shown only).
   */
  chatPost(post: ChatPost): Promise<ChatEntry | null>;
  /** The chat so far and the agent's state. */
  chatView(): Promise<ChatView>;
  /** New chat entries and agent state changes. Set once. */
  onChatEvent(handler: (event: ChatEvent) => void): void;
  /** The shown project's chats, newest first (🕘). */
  chatList(): Promise<ChatListItem[]>;
  /** Up to 200 lines of a saved chat before line `before` (the latest when left out). */
  chatRead(chatId: string, before?: number): Promise<ChatPage>;
  /** Start a new chat; false when the shown one has no message yet or no project is shown. */
  chatNew(): Promise<boolean>;
  /** `app.getVersion()`. */
  getAppVersion(): Promise<string>;
  /** The third-party notices text (rejects when the file is missing). */
  getThirdPartyNotices(): Promise<string>;
  /** OS and CPU for the feedback setup line. */
  getSystemInfo(): Promise<SystemInfo>;
  /** Open a new GitHub issue or the feedback form in the browser, the setup line filled in; false when it couldn't. */
  openFeedback(place: FeedbackPlace, setup?: string): Promise<boolean>;
}
