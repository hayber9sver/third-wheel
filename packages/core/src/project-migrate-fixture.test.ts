import path from 'node:path';
import { describe, expect, it } from 'vitest';
import bracket from './fixtures/v1-folder/bracket.step.thirdwheel.json?raw';
import bracketV2 from './fixtures/v1-folder/bracket_v2.step.thirdwheel.json?raw';
import lid from './fixtures/v1-folder/lid.step.thirdwheel.json?raw';
import { collectSidecars, migrateSidecars } from './project-migrate.js';
import { projectFiles } from './project-paths.js';
import { readMarks, readProject, saveProject } from './project-store.js';
import { must } from './testing/fixtures.js';
import { MemoryFs, counterRandom } from './testing/memory-fs.js';

/**
 * Old sidecars as the app wrote them (fixtures/v1-folder): a bracket with a second version, the
 * chain's absolute paths from a folder that has since moved, a comment deleted in v2, and an
 * unrelated lid using the same marker and comment ids. Keep these files: every later schema must
 * still migrate them.
 */
describe('v1 folder fixture → project', () => {
  for (const [os, p, folder] of [
    ['macOS', path.posix, '/Users/me/projects/bracket'],
    ['Windows', path.win32, 'C:\\Users\\me\\projects\\bracket'],
  ] as const) {
    it(`migrates, saves and reads back (${os})`, async () => {
      const fs = new MemoryFs(p);
      fs.addFile(p.join(folder, 'bracket.step.thirdwheel.json'), bracket);
      fs.addFile(p.join(folder, 'bracket_v2.step.thirdwheel.json'), bracketV2);
      fs.addFile(p.join(folder, 'lid.step.thirdwheel.json'), lid.replace(/\n/g, '\r\n'));
      const { sidecars, unreadable } = await collectSidecars(fs, folder, p);
      expect(unreadable).toEqual([]);
      const { project, marks, report } = migrateSidecars({
        folder,
        sidecars,
        path: p,
        now: new Date('2026-11-21T12:00:00.000Z'),
        random: counterRandom(),
      });

      const br = must(project.models.find((m) => m.name === 'bracket'));
      const li = must(project.models.find((m) => m.name === 'lid'));
      expect(br.versions.map((v) => v.path)).toEqual(['bracket.step', 'bracket_v2.step']);
      expect(must(br.versions[1]).from).toBe(must(br.versions[0]).id);
      expect(br.bodyTree?.bodies).toEqual([
        { body: { name: 'Pin', index: 1 }, parent: { folder: 'n1' } },
      ]);
      expect(li.versions.map((v) => v.path)).toEqual(['lid.step']);

      // Comments once: c1 resolved with its thread (v2's copy), c2 deleted in v2, the lid's own c1.
      const onBracket = project.comments.filter((c) => c.modelId === br.id);
      expect(onBracket.map((c) => [c.id, c.status])).toEqual([['c1', 'resolved']]);
      expect(must(onBracket[0]).replies).toHaveLength(1);
      const onLid = must(project.comments.find((c) => c.modelId === li.id));
      expect(onLid.id).not.toBe('c1');
      expect(onLid.linkedParts).toEqual([br.id]);
      expect(onLid.markerIds).not.toEqual(['m1']);
      expect(report).toMatchObject({
        deletedComments: 1,
        renamedMarkers: 1,
        versionsWithoutNotes: 0,
      });

      const files = projectFiles(folder, p);
      await saveProject(fs, files, { project, marks });
      expect(await readProject(fs, files)).toEqual({ kind: 'ok', data: project });
      const v2 = await readMarks(fs, files, must(br.versions[1]).id);
      if (v2.kind !== 'ok') throw new Error(v2.kind);
      expect(must(v2.data.markers[0]).transfer?.status).toBe('changed');
      expect(must(must(v2.data.markers[0]).paint.faces[0]).faceId).toBe(9);
      // The old sidecars are untouched.
      expect(fs.read(p.join(folder, 'bracket.step.thirdwheel.json'))).toBe(bracket);
    });
  }
});
