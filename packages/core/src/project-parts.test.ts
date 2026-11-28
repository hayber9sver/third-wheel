import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectParts } from './project-parts.js';
import type { Project } from './project-schema.js';
import { H, sampleProject } from './testing/fixtures.js';

const P = path.posix;
const T = '2026-11-21T12:00:00.000Z';

/** The sample bracket plus a separate lid part (two versions, the newer one saved over). */
function twoParts(): Project {
  const p = sampleProject();
  return {
    ...p,
    models: [
      ...p.models,
      {
        id: 'part000002',
        name: 'lid',
        versions: [
          {
            id: 'ver0000003',
            path: 'lid.step',
            contentHash: H('c'),
            format: 'step',
            added: T,
            overwritten: true,
          },
          {
            id: 'ver0000004',
            path: 'lid.step',
            contentHash: H('d'),
            format: 'step',
            added: '2026-11-21T13:00:00.000Z',
            from: 'ver0000003',
          },
        ],
      },
      { id: 'part000003', name: 'empty', versions: [] },
    ],
    comments: [
      ...p.comments,
      ...(['open', 'resolved', 'open'] as const).map((status, i) => ({
        id: `c${String(i + 2)}`,
        modelId: 'part000002',
        text: 'lid remark',
        markerIds: [],
        status,
        author: 'human' as const,
        createdAt: T,
        updatedAt: T,
      })),
    ],
  };
}

describe('projectParts', () => {
  it('lists each part with its newest version and open comments, in the order added', () => {
    const rows = projectParts(twoParts(), '/w/cad', P, 'part000002');
    expect(rows).toEqual([
      {
        partId: 'part000001',
        name: 'bracket',
        file: '/w/exports/bracket_v2.step',
        fileName: 'bracket_v2.step',
        contentHash: H('b'),
        openComments: 1,
        shown: false,
      },
      {
        partId: 'part000002',
        name: 'lid',
        file: '/w/cad/lid.step',
        fileName: 'lid.step',
        contentHash: H('d'),
        openComments: 2,
        shown: true,
      },
    ]);
  });

  it('skips a version whose contents were saved over, and parts with no versions', () => {
    const p = twoParts();
    // The overwritten one added last still doesn't count as the newest.
    const lid = p.models[1];
    if (!lid) throw new Error('fixture');
    const [old, now] = lid.versions;
    if (!old || !now) throw new Error('fixture');
    lid.versions[0] = { ...old, added: '2026-11-21T14:00:00.000Z' };
    lid.versions[1] = { ...now, from: undefined };
    const rows = projectParts(p, '/w/cad', P);
    expect(rows.map((r) => [r.name, r.contentHash, r.shown])).toEqual([
      ['bracket', H('b'), false],
      ['lid', H('d'), false],
    ]);
  });
});
