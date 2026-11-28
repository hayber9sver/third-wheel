/**
 * `load_model` rules (the AI works inside the project folder): the texts of a refused load. Each
 * says what is wrong, the exact path to use instead, and to stop and tell the user when it can't
 * save there — so an agent that can't follow it doesn't retry forever.
 */

const NO_RETRY = "If you can't save there, don't try again: tell the user.";

/** The file lies outside the open project's folder. */
export function outsideProjectText(name: string, folder: string, suggest: string): string {
  return `Not loaded: ${name} is outside the project folder ${folder}. load_model opens models only from the open project's folder (and its subfolders). Save or copy it as ${suggest} and load that. ${NO_RETRY}`;
}

/** The file lies in a folder under the project's that has a project of its own. */
export function otherProjectText(
  name: string,
  otherFolder: string,
  folder: string,
  suggest: string,
): string {
  return `Not loaded: ${name} is in ${otherFolder}, a folder with its own project, not in the open project (${folder}). Save or copy it as ${suggest} and load that. ${NO_RETRY}`;
}

/** A new version (`revisionOf`) saved over a file the project lists with other contents. */
export function savedOverText(name: string, suggest: string): string {
  return `Not loaded: ${name} is already a version in the project with other contents (the new export was saved over it). Each new version needs a new file name: save it as ${suggest} and load that with revisionOf. ${NO_RETRY}`;
}

/** `revisionOf` names a model of another project than the open one. */
export function otherProjectParentText(
  parentName: string,
  parentFolder: string,
  folder: string,
): string {
  return `Not loaded: revisionOf names ${parentName}, which belongs to another project (${parentFolder}), not the open one (${folder}). A new version stays in the project of its earlier version. Load the file without revisionOf, or ask the user to open ${parentFolder}.`;
}

/** Allowed (not a new version): a listed file saved over in place keeps its version. */
export function changedOnDiskHint(name: string, saveNextAs: string): string {
  return `${name} changed on disk since it was listed, so it stays the same version with the new contents (its markers were moved onto them). Save each new version of your own under a new name, e.g. ${saveNextAs}, and load it with revisionOf.`;
}
