import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_PROJECT_DIR_PATH,
  NEW_ID_LENGTH,
  ProjectPathError,
  isKnownProjectEntry,
  newId,
  newUniqueId,
  projectFiles,
  projectSearchFolders,
  resolveStoredPath,
  toStoredPath,
} from './project-paths.js';
import { isFileId } from './project-schema.js';

const win = path.win32;
const posix = path.posix;

describe('newId', () => {
  it('makes safe, random ids of the set length', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId()));
    expect(ids.size).toBe(2000);
    for (const id of ids) {
      expect(id).toHaveLength(NEW_ID_LENGTH);
      expect(isFileId(id)).toBe(true);
      expect(id[0]).toMatch(/[a-z]/);
    }
  });

  it('never starts with a digit, even from all-zero or all-255 bytes', () => {
    expect(newId(() => new Uint8Array(NEW_ID_LENGTH))).toBe('a000000000');
    expect(isFileId(newId(() => new Uint8Array(NEW_ID_LENGTH).fill(255)))).toBe(true);
  });

  it('newUniqueId tries again on a collision', () => {
    let n = 0;
    const random = (k: number): Uint8Array => new Uint8Array(k).fill(n++ < 3 ? 0 : 1);
    const taken = new Set(['a000000000']);
    expect(newUniqueId(taken, random)).toBe('b111111111');
    expect(taken.has('b111111111')).toBe(true);
  });
});

describe('toStoredPath / resolveStoredPath', () => {
  it('Windows: same drive → relative with /', () => {
    expect(toStoredPath('C:\\work\\proj', 'C:\\work\\proj\\out\\part.step', win)).toEqual({
      path: 'out/part.step',
    });
  });

  it('Windows: a folder up → ../', () => {
    const s = toStoredPath('C:\\work\\proj', 'C:\\work\\exports\\part.step', win);
    expect(s).toEqual({ path: '../exports/part.step' });
    expect(resolveStoredPath('C:\\work\\proj', s, win)).toBe('C:\\work\\exports\\part.step');
  });

  it('Windows: another drive → absolute, outside', () => {
    expect(toStoredPath('C:\\work\\proj', 'D:\\exports\\part.step', win)).toEqual({
      path: 'D:\\exports\\part.step',
      outside: true,
    });
  });

  it('Windows: a network file → outside', () => {
    expect(toStoredPath('C:\\proj', '\\\\nas\\share\\part.step', win).outside).toBe(true);
  });

  it('Windows: drive letter case does not matter (case-insensitive like the drive)', () => {
    expect(toStoredPath('C:\\Work\\Proj', 'c:\\work\\proj\\a.step', win)).toEqual({
      path: 'a.step',
    });
  });

  it('a moved project folder still finds relative versions', () => {
    const s = toStoredPath('/Users/me/cad', '/Users/me/cad/out/a.step', posix);
    expect(resolveStoredPath('/Volumes/usb/cad', s, posix)).toBe('/Volumes/usb/cad/out/a.step');
    expect(resolveStoredPath('E:\\cad', s, win)).toBe('E:\\cad\\out\\a.step');
  });

  it('POSIX: names with spaces, dots and unicode survive', () => {
    const s = toStoredPath('/p', '/p/my part v1.2 (é).step', posix);
    expect(s).toEqual({ path: 'my part v1.2 (é).step' });
    expect(resolveStoredPath('/p', s, posix)).toBe('/p/my part v1.2 (é).step');
  });

  it('the project folder itself is never a version path', () => {
    expect(toStoredPath('/p', '/p', posix).outside).toBe(true);
  });
});

describe('projectFiles', () => {
  it('builds the paths with the system separator', () => {
    const f = projectFiles('C:\\work\\proj', win);
    expect(f.project).toBe('C:\\work\\proj\\.thirdwheel\\project.json');
    expect(f.marks('abc123')).toBe('C:\\work\\proj\\.thirdwheel\\marks\\abc123.json');
    expect(f.chat('abc123')).toBe('C:\\work\\proj\\.thirdwheel\\chats\\abc123.jsonl');
  });

  it('refuses ids that would escape the folder or are not safe file names', () => {
    const f = projectFiles('/p', posix);
    for (const bad of ['../evil', 'a/b', 'CON', 'con', 'Abc', '']) {
      expect(() => f.marks(bad)).toThrow(ProjectPathError);
    }
  });

  it('refuses a folder whose .thirdwheel path is too long, with a clear message', () => {
    const okFolder = `C:\\${'a'.repeat(MAX_PROJECT_DIR_PATH - '\\.thirdwheel'.length - 3)}`;
    expect(projectFiles(okFolder, win).dir).toHaveLength(MAX_PROJECT_DIR_PATH);
    expect(() => projectFiles(`${okFolder}b`, win)).toThrow(/too long/);
    // Deepest file stays below Windows' 260-character limit.
    const deepest = `${projectFiles(okFolder, win).marks('a'.repeat(32))}.${'a'.repeat(10)}.tmp`;
    expect(deepest.length).toBeLessThan(260);
  });

  it('refuses network folders', () => {
    expect(() => projectFiles('\\\\nas\\share\\cad', win)).toThrow(/network/);
    expect(() => projectFiles('//nas/share/cad', posix)).toThrow(/network/);
  });
});

describe('projectSearchFolders', () => {
  it('walks up to the home folder and stops there', () => {
    expect(projectSearchFolders('/Users/me/cad/out', '/Users/me', posix)).toEqual([
      '/Users/me/cad/out',
      '/Users/me/cad',
      '/Users/me',
    ]);
  });

  it('home given with a trailing slash still stops there', () => {
    expect(projectSearchFolders('/Users/me/cad', '/Users/me/', posix)).toEqual([
      '/Users/me/cad',
      '/Users/me',
    ]);
  });

  it('a folder next to home (/Users/meme) is not inside home', () => {
    expect(projectSearchFolders('/Users/meme/cad', '/Users/me', posix)).toEqual([
      '/Users/meme/cad',
      '/Users/meme',
      '/Users',
      '/',
    ]);
  });

  it('a folder named "..x" inside home is still inside home', () => {
    expect(projectSearchFolders('/Users/me/..x', '/Users/me', posix)).toEqual([
      '/Users/me/..x',
      '/Users/me',
    ]);
  });

  it('outside home goes up to the root', () => {
    expect(projectSearchFolders('/Volumes/usb/cad', '/Users/me', posix)).toEqual([
      '/Volumes/usb/cad',
      '/Volumes/usb',
      '/Volumes',
      '/',
    ]);
  });

  it('Windows: another drive goes up to that drive root', () => {
    expect(projectSearchFolders('D:\\cad\\out', 'C:\\Users\\me', win)).toEqual([
      'D:\\cad\\out',
      'D:\\cad',
      'D:\\',
    ]);
  });

  it('Windows: home in another case still stops there', () => {
    expect(projectSearchFolders('c:\\users\\ME\\cad', 'C:\\Users\\me', win)).toEqual([
      'c:\\users\\ME\\cad',
      'c:\\users\\ME',
    ]);
  });

  it('network paths give none', () => {
    expect(projectSearchFolders('\\\\nas\\share\\cad', 'C:\\Users\\me', win)).toEqual([]);
  });
});

describe('isKnownProjectEntry', () => {
  it('flags sync conflict copies and stray files', () => {
    for (const n of ['project (1).json', 'project-PC.json', 'notes.txt', 'Project.json']) {
      expect(isKnownProjectEntry('dir', n)).toBe(false);
    }
    for (const n of ['abc (1).json', 'ABC.json', 'abc.jsonl', 'abc-conflict.json']) {
      expect(isKnownProjectEntry('marks', n)).toBe(false);
    }
    expect(isKnownProjectEntry('chats', 'abc.json')).toBe(false);
  });

  it('accepts our files, temp files and backups', () => {
    for (const n of ['project.json', 'marks', 'chats', 'lock', 'project.json.k3f9x2a1qz.tmp']) {
      expect(isKnownProjectEntry('dir', n)).toBe(true);
    }
    expect(isKnownProjectEntry('dir', 'project.2026-11-21-140509.bak.json')).toBe(true);
    expect(isKnownProjectEntry('chats', 'abc.2026-11-21-140509.bak.jsonl')).toBe(true);
    expect(isKnownProjectEntry('marks', 'k3f9x2a1qz.json')).toBe(true);
    expect(isKnownProjectEntry('chats', 'k3f9x2a1qz.jsonl')).toBe(true);
  });
});
