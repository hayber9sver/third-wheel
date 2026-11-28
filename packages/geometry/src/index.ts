/** STEP import (worker), entity maps, picking helpers. */
export * from './model.js';
export {
  importStep,
  isOutOfMemory,
  outOfMemoryMessage,
  type ImportOptions,
} from './step-import.js';
export {
  importMesh,
  meshFormatOf,
  meshModel,
  parse3mf,
  parseStl,
  MESH_FACE_TYPE,
  type MeshBody,
  type MeshFormat,
} from './mesh-import.js';
export {
  NO_KEPT_SHAPES,
  serveStepImports,
  StepImportClient,
  type ImportProgress,
  type KeepOptions,
  type MessageEndpoint,
} from './import-worker.js';
export {
  entityInfo,
  faceAreas,
  measure,
  meshDistance,
  MAX_DISTANCE_PAIRS,
  type EntityInfo,
  type EntityKind,
  type EntityRef,
  type InfoModel,
  type Measurement,
} from './entity-info.js';
export { entityDimension, pairDimension, type Dimension, type DimensionKind } from './dimension.js';
export type { V3 } from './vec.js';
export {
  isEmptyExactRequest,
  KeptShapes,
  pairKey,
  type ExactRequest,
  type ExactResult,
} from './exact.js';
export { CHAIN_ANGLE_DEG, edgesInChain } from './edge-chain.js';
export { meshHash, type MeshHashModel } from './mesh-hash.js';
export { bodyFingerprints, edgeMidpoint, entityFingerprints, faceCentres } from './fingerprint.js';
export {
  describeEntity,
  estimateTokens,
  commentPayload,
  filterReviewPayload,
  reviewPayload,
  reviewPayloadText,
  type ReviewComment,
  type ReviewEntity,
  type ReviewFace,
  type ReviewMarker,
  type ReviewModel,
  type ReviewOptions,
  type ReviewPaint,
  type ReviewPayload,
} from './review.js';
export { paintSamples, type PaintedTriangle, type SampleModel } from './paint-samples.js';
export {
  matchBodies,
  placeGhost,
  transferAnnotations,
  transferMeshAnnotations,
  type MeshTransferResult,
  type PlacedGhost,
  type TransferModel,
  type TransferResult,
  type TransferStatus,
} from './transfer.js';
