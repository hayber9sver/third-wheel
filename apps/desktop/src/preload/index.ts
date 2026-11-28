/** Preload (sandboxed): exposes a minimal, typed API to the renderer. */
import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type BridgeRendererReply,
  type BridgeRendererRequest,
  type ModelFile,
  type ModelVersionFile,
  type AddModelPick,
  type ProjectState,
  type StartState,
  type SaveResult,
  type VersionFileState,
  type LinkResult,
  type OpenedVersion,
  type ProjectVersions,
  type ProjectPartRow,
  type ThirdWheelApi,
} from '../shared/ipc.js';
import type { AiActivity, ConnectPlan, ConnectResult, McpSetup } from '../shared/ai-status.js';
import type { ChatEntry, ChatEvent, ChatListItem, ChatPage, ChatView } from '../shared/chat.js';
import type { AllowPlan, AllowResult } from '../shared/chat-setup.js';
import type { RemoveResult } from '../shared/claude-setup.js';
import { isMenuCommand } from '../shared/menu-commands.js';
import type { SystemInfo } from '../shared/feedback.js';

const api: ThirdWheelApi = {
  setThemeSource(mode) {
    ipcRenderer.send(IPC.setThemeSource, mode);
  },
  openModelDialog(title, shownPath) {
    return ipcRenderer.invoke(IPC.openModelDialog, title, shownPath) as Promise<ModelFile | null>;
  },
  rereadModelFile(path, open) {
    return ipcRenderer.invoke(IPC.rereadModelFile, path, open) as Promise<ModelFile>;
  },
  openVersion(modelPath, contentHash) {
    return ipcRenderer.invoke(IPC.openVersion, modelPath, contentHash) as Promise<OpenedVersion>;
  },
  versionFileStates(paths) {
    return ipcRenderer.invoke(IPC.versionFileStates, paths) as Promise<VersionFileState[]>;
  },
  linkProjectVersion(path, contentHash, parent) {
    return ipcRenderer.invoke(
      IPC.linkProjectVersion,
      path,
      contentHash,
      parent,
    ) as Promise<LinkResult>;
  },
  projectFolders(paths) {
    return ipcRenderer.invoke(IPC.projectFolders, paths) as Promise<string[]>;
  },
  replaceVersionContents(path, oldHash, newHash) {
    return ipcRenderer.invoke(IPC.replaceVersionContents, path, oldHash, newHash) as Promise<void>;
  },
  isEarlierVersion(maybe, of) {
    return ipcRenderer.invoke(IPC.isEarlierVersion, maybe, of) as Promise<boolean>;
  },
  addProjectPart(path) {
    return ipcRenderer.invoke(IPC.addProjectPart, path) as Promise<void>;
  },
  projectPartOf(path, contentHash) {
    return ipcRenderer.invoke(IPC.projectPartOf, path, contentHash) as Promise<{
      folder: string;
      partId: string;
    } | null>;
  },
  projectVersions(path, contentHash) {
    return ipcRenderer.invoke(
      IPC.projectVersions,
      path,
      contentHash,
    ) as Promise<ProjectVersions | null>;
  },
  projectParts(shown) {
    return ipcRenderer.invoke(IPC.projectParts, shown) as Promise<readonly ProjectPartRow[]>;
  },
  removeProjectVersion(path, contentHash, versionId) {
    return ipcRenderer.invoke(
      IPC.removeProjectVersion,
      path,
      contentHash,
      versionId,
    ) as Promise<void>;
  },
  locateProjectVersion(path, contentHash, versionId, moved) {
    return ipcRenderer.invoke(
      IPC.locateProjectVersion,
      path,
      contentHash,
      versionId,
      moved,
    ) as Promise<void>;
  },
  listModelVersions(modelPath) {
    return ipcRenderer.invoke(IPC.listModelVersions, modelPath) as Promise<ModelVersionFile[]>;
  },
  saveSidecar(modelPath, text, backupFirst) {
    return ipcRenderer.invoke(
      IPC.saveSidecar,
      modelPath,
      text,
      backupFirst === true,
    ) as Promise<SaveResult>;
  },
  saveSidecarSync(modelPath, text, backupFirst) {
    return ipcRenderer.sendSync(
      IPC.saveSidecarSync,
      modelPath,
      text,
      backupFirst === true,
    ) as SaveResult;
  },
  backupSidecar(modelPath, contentHash) {
    return ipcRenderer.invoke(IPC.backupSidecar, modelPath, contentHash) as Promise<string | null>;
  },
  projectShown(modelPath) {
    return ipcRenderer.invoke(IPC.projectShown, modelPath) as Promise<ProjectState>;
  },
  newProjectHere(modelPath) {
    return ipcRenderer.invoke(IPC.newProjectHere, modelPath) as Promise<ProjectState | null>;
  },
  saveProjectAs(modelPath) {
    return ipcRenderer.invoke(IPC.saveProjectAs, modelPath) as Promise<ProjectState | null>;
  },
  onProjectState(listener) {
    ipcRenderer.on(IPC.projectState, (_event, state: ProjectState | undefined) => {
      listener(state);
    });
  },
  onProjectNotice(listener) {
    ipcRenderer.on(IPC.projectNotice, (_event, text: string) => {
      listener(text);
    });
  },
  newProjectFolder() {
    return ipcRenderer.invoke(IPC.newProjectFolder) as Promise<{
      state: ProjectState;
      existed: boolean;
    } | null>;
  },
  onEmptyProject(listener) {
    ipcRenderer.on(IPC.emptyProject, (_event, folder: string) => {
      listener(folder);
    });
  },
  openEmptyProject(folder) {
    return ipcRenderer.invoke(IPC.openEmptyProject, folder) as Promise<ProjectState>;
  },
  startState() {
    return ipcRenderer.invoke(IPC.startState) as Promise<StartState>;
  },
  openRecentProject(folder) {
    return ipcRenderer.invoke(IPC.openRecentProject, folder) as Promise<void>;
  },
  openFolderDialog() {
    return ipcRenderer.invoke(IPC.openFolderDialog) as Promise<void>;
  },
  addModelDialog() {
    return ipcRenderer.invoke(IPC.addModelDialog) as Promise<AddModelPick | null>;
  },
  onModelFile(listener) {
    ipcRenderer.on(IPC.modelFile, (_event, file: ModelFile) => {
      listener(file);
    });
  },
  sendPerfResult(result) {
    ipcRenderer.send(IPC.perfResult, result);
  },
  onBridgeRequest(handler) {
    ipcRenderer.on(IPC.bridgeRequest, (_event, req: BridgeRendererRequest) => {
      const reply = (r: BridgeRendererReply): void => {
        ipcRenderer.send(IPC.bridgeReply, r);
      };
      Promise.resolve()
        .then(() => handler(req.method, req.params))
        .then(
          (result) => {
            reply({ requestId: req.requestId, ok: true, result });
          },
          (err: unknown) => {
            reply({
              requestId: req.requestId,
              ok: false,
              message: err instanceof Error ? err.message : String(err),
            });
          },
        );
    });
  },
  getAiActivity() {
    return ipcRenderer.invoke(IPC.getAiActivity) as Promise<AiActivity>;
  },
  onAiActivity(handler) {
    ipcRenderer.on(IPC.aiActivity, (_event, activity: AiActivity) => {
      handler(activity);
    });
  },
  chatSend(text) {
    return ipcRenderer.invoke(IPC.chatSend, text) as Promise<ChatEntry | null>;
  },
  chatPost(post) {
    return ipcRenderer.invoke(IPC.chatPost, post) as Promise<ChatEntry | null>;
  },
  chatView() {
    return ipcRenderer.invoke(IPC.chatView) as Promise<ChatView>;
  },
  onChatEvent(handler) {
    ipcRenderer.on(IPC.chatEvent, (_event, e: ChatEvent) => {
      handler(e);
    });
  },
  chatList() {
    return ipcRenderer.invoke(IPC.chatList) as Promise<ChatListItem[]>;
  },
  chatRead(chatId, before) {
    return ipcRenderer.invoke(IPC.chatRead, chatId, before) as Promise<ChatPage>;
  },
  chatNew() {
    return ipcRenderer.invoke(IPC.chatNew) as Promise<boolean>;
  },
  getMcpSetup() {
    return ipcRenderer.invoke(IPC.getMcpSetup) as Promise<McpSetup>;
  },
  findAgent(agent) {
    return ipcRenderer.invoke(IPC.findAgent, agent) as Promise<string | null>;
  },
  connectAgent(agent, target) {
    return ipcRenderer.invoke(IPC.connectAgent, agent, target) as Promise<ConnectResult>;
  },
  planConnect(agent, target, useShell) {
    return ipcRenderer.invoke(IPC.planConnect, agent, target, useShell) as Promise<ConnectPlan>;
  },
  chooseFolder(startIn) {
    return ipcRenderer.invoke(IPC.chooseFolder, startIn) as Promise<string | null>;
  },
  planAllow(agent, folder, cad) {
    return ipcRenderer.invoke(IPC.planAllow, agent, folder, cad) as Promise<AllowPlan>;
  },
  writeAllow(agent, folder, cad, shown) {
    return ipcRenderer.invoke(IPC.writeAllow, agent, folder, cad, shown) as Promise<AllowResult>;
  },
  removeEntry(agent, target, which) {
    return ipcRenderer.invoke(IPC.removeEntry, agent, target, which) as Promise<RemoveResult>;
  },
  onShowAbout(handler) {
    ipcRenderer.on(IPC.showAbout, () => {
      handler();
    });
  },
  onMenuCommand(handler) {
    ipcRenderer.on(IPC.menuCommand, (_event, command: unknown) => {
      if (isMenuCommand(command)) handler(command);
    });
  },
  textUndoRedo(which) {
    ipcRenderer.send(IPC.textUndoRedo, which);
  },
  getAppVersion() {
    return ipcRenderer.invoke(IPC.getAppVersion) as Promise<string>;
  },
  getThirdPartyNotices() {
    return ipcRenderer.invoke(IPC.getThirdPartyNotices) as Promise<string>;
  },
  getSystemInfo() {
    return ipcRenderer.invoke(IPC.getSystemInfo) as Promise<SystemInfo>;
  },
  openFeedback(place, setup) {
    return ipcRenderer.invoke(IPC.openFeedback, place, setup) as Promise<boolean>;
  },
};

contextBridge.exposeInMainWorld('thirdWheel', api);
