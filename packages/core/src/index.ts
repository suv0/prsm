export { loadConfig, resolveDefaultConfigPath } from "./config.js";
export { isFatalProviderError, describeProviderFailure } from "./provider-errors.js";
export { runPipeline } from "./pipeline.js";
export { detectSignals } from "./signals.js";
export type { ReviewSignal, SignalReport } from "./signals.js";
export { planReview } from "./planner.js";
export type { PlannerInput } from "./planner.js";
export { buildKnowledgePack } from "./knowledge.js";
export type { KnowledgeInput, KnowledgePack } from "./knowledge.js";
export { filterFindingsByEvidence } from "./evidence.js";
export type {
  EvidenceFilterOptions,
  EvidenceFilterResult,
} from "./evidence.js";
export { finalizeFindings, dedupeFindings, buildJudgeResult } from "./finalize.js";
export {
  alignFindingSuggestionPaths,
  alignFindingsSuggestionPaths,
  resolveSuggestedModulePath,
} from "./finding-consistency.js";
export { writeAgentWorkspace } from "./agent-prepare.js";
export { finalizeReviewRun } from "./finalize-run.js";
export {
  mergeAgentFindings,
  findingsLikelySame,
  rebuildMergedReview,
} from "./merge-runs.js";
export {
  makeRunId,
  resolveAgentName,
  listReviewRuns,
  archiveLegacyTopLevelIfNeeded,
  snapshotAgentRun,
  versionCompletedReview,
  clearWorkingPasses,
  tagFindingsWithAgent,
} from "./versioning.js";
export type { ReviewRunMeta, AgentsIndex } from "./versioning.js";
export { buildDiffIndex, reconcileFindingLines } from "./diff-index.js";
export type { DiffFileIndex, LineReconcileResult } from "./diff-index.js";
export {
  applyDocumentedIntent,
  intentEvidenceFromFinding,
  INTENT_PATTERNS,
} from "./documented-intent.js";
export type { DocumentedIntentResult } from "./documented-intent.js";
export {
  extractDiffForFile,
  buildReverifyPrompt,
  parseRecheckModelResponse,
  applyRecheckToRun,
  applyReverifyToRun,
  applyDispositionToRun,
  ensureUniqueFindingIds,
  buildTeachMeFallback,
  notesAllowDrop,
  notesMarkFalseAlarm,
  notesWantPasteComment,
  notesWantTeachMe,
  extractDraftCommentFromNotes,
  extractTeachMeLoose,
  extractTeachMeLinesArray,
  extractJsonFenceContent,
  normalizeTeachMeContent,
  finalizeTeachMe,
  extractSuggestedCommentLoose,
  buildConversationalPaste,
  looksLikeReviewerMetaReply,
  looksLikeAuthorFacingPrComment,
  markFindingFalseAlarm,
  reopenFinding,
} from "./reverify.js";
export type {
  ReverifyAction,
  ReverifyApplyResult,
  ParsedRecheckResponse,
} from "./reverify.js";
export {
  matchFindingsToThreads,
  scoreFindingThread,
  buildVerifyFixPrompt,
  buildBatchVerifyFixPrompt,
  parseVerifyModelResponse,
  parseBatchVerifyModelResponse,
  toFindingVerification,
  rollupVerifications,
  upsertAgentVerification,
  buildVerifyReport,
  applyVerificationsToRun,
  fileDiffForFinding,
  chunkPairs,
} from "./verify-fixes.js";
export type { VerifyThread, VerifyThreadMessage } from "./verify-fixes.js";
export type {
  Pass,
  PassContext,
  PipelineResult,
  Provider,
  ProviderRequest,
  ProviderResponse,
} from "./types.js";
export type { RunPipelineOptions, PipelineDeps } from "./pipeline.js";
