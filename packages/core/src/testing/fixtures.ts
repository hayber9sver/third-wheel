/** Sample v2 project files for tests (not exported from the package). */
import type { Project, VersionMarks } from '../project-schema.js';

export const H = (c: string): string => `sha256:${c.repeat(64)}`;
const T = '2026-11-21T10:00:00.000Z';

export function sampleProject(): Project {
  return {
    schemaVersion: 2,
    id: 'pqrs000001',
    name: 'bracket',
    created: T,
    tessellation: { linearDeflection: 0.1, angularDeflection: 0.5 },
    models: [
      {
        id: 'part000001',
        name: 'bracket',
        versions: [
          { id: 'ver0000001', path: 'bracket.step', contentHash: H('a'), format: 'step', added: T },
          {
            id: 'ver0000002',
            path: '../exports/bracket_v2.step',
            contentHash: H('b'),
            format: 'step',
            added: '2026-11-21T11:00:00.000Z',
            from: 'ver0000001',
          },
        ],
      },
    ],
    markers: [{ id: 'm1', name: 'Marker 1', color: '#ff0000', visible: true }],
    comments: [
      {
        id: 'c1',
        modelId: 'part000001',
        text: 'wall too thin',
        markerIds: ['m1'],
        status: 'open',
        author: 'human',
        createdAt: T,
        updatedAt: T,
      },
    ],
    chats: [],
  };
}

export function sampleMarks(): VersionMarks {
  return {
    schemaVersion: 2,
    versionId: 'ver0000001',
    contentHash: H('a'),
    tessellation: { linearDeflection: 0.1, angularDeflection: 0.5 },
    markers: [
      {
        id: 'm1',
        entities: [{ kind: 'face', id: 3, seq: 1 }],
        paint: { faces: [{ faceId: 3, triangles: [[10, 4]] }] },
      },
    ],
  };
}

/** The value, or a test failure when it is missing (instead of a `!` assertion). */
export function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected a value');
  return v;
}
