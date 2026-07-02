import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE } from "../../bootstrap-files.js";
import { normalizeStructuredPromptSection } from "../../prompt-cache-stability.js";

export const ATTEMPT_CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";

export function composeSystemPromptWithHookContext(params: {
  baseSystemPrompt?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}): string | undefined {
  const prependSystem =
    typeof params.prependSystemContext === "string"
      ? normalizeStructuredPromptSection(params.prependSystemContext)
      : "";
  const appendSystem =
    typeof params.appendSystemContext === "string"
      ? normalizeStructuredPromptSection(params.appendSystemContext)
      : "";
  if (!prependSystem && !appendSystem) {
    return undefined;
  }
  return joinPresentTextSegments([prependSystem, params.baseSystemPrompt, appendSystem], {
    trim: true,
  });
}

export function resolveAttemptSpawnWorkspaceDir(params: {
  sandbox?: {
    enabled?: boolean;
    workspaceAccess?: string;
  } | null;
  resolvedWorkspace: string;
}): string | undefined {
  return params.sandbox?.enabled && params.sandbox.workspaceAccess !== "rw"
    ? params.resolvedWorkspace
    : undefined;
}

export function shouldUseOpenAIWebSocketTransport(params: {
  provider: string;
  modelApi?: string | null;
}): boolean {
  // openai-codex normalizes to the ChatGPT backend HTTP path, not the public
  // OpenAI Responses websocket endpoint. Keep it on HTTP until a provider-
  // specific websocket target exists and is verified end-to-end.
  return params.modelApi === "openai-responses" && params.provider === "openai";
}

export function shouldAppendAttemptCacheTtl(params: {
  timedOutDuringCompaction: boolean;
  compactionOccurredThisAttempt: boolean;
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  modelApi?: string;
  isCacheTtlEligibleProvider: (provider: string, modelId: string, modelApi?: string) => boolean;
}): boolean {
  if (params.timedOutDuringCompaction || params.compactionOccurredThisAttempt) {
    return false;
  }
  return (
    params.config?.agents?.defaults?.contextPruning?.mode === "cache-ttl" &&
    params.isCacheTtlEligibleProvider(params.provider, params.modelId, params.modelApi)
  );
}

export function appendAttemptCacheTtlIfNeeded(params: {
  sessionManager: {
    appendCustomEntry?: (customType: string, data: unknown) => void;
  };
  timedOutDuringCompaction: boolean;
  compactionOccurredThisAttempt: boolean;
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  modelApi?: string;
  isCacheTtlEligibleProvider: (provider: string, modelId: string, modelApi?: string) => boolean;
  now?: number;
}): boolean {
  if (!shouldAppendAttemptCacheTtl(params)) {
    return false;
  }
  params.sessionManager.appendCustomEntry?.(ATTEMPT_CACHE_TTL_CUSTOM_TYPE, {
    timestamp: params.now ?? Date.now(),
    provider: params.provider,
    modelId: params.modelId,
  });
  return true;
}

export function shouldPersistCompletedBootstrapTurn(params: {
  shouldRecordCompletedBootstrapTurn: boolean;
  promptError: unknown;
  aborted: boolean;
  timedOutDuringCompaction: boolean;
  compactionOccurredThisAttempt: boolean;
}): boolean {
  if (!params.shouldRecordCompletedBootstrapTurn || params.promptError || params.aborted) {
    return false;
  }
  // Compaction timeout means the turn was unstable — don't write the marker.
  // However, successful compaction during a turn is exactly when we MOST need
  // the marker: without it, every subsequent turn re-injects the full workspace
  // context (~25k chars) because hasCompletedBootstrapTurn() sees compaction
  // after the latest marker and returns false. Writing the marker after a
  // successful compaction allows continuation-skip to resume immediately.
  if (params.timedOutDuringCompaction) {
    return false;
  }
  return true;
}

export function appendFullBootstrapContextMarker(params: {
  sessionManager: {
    appendCustomEntry?: (customType: string, data: unknown) => void;
  };
  runId: string;
  sessionId: string;
  phase: "prompt-start" | "prompt-complete";
  compactionOccurredThisAttempt?: boolean;
  now?: number;
  warn?: (message: string) => void;
}): boolean {
  try {
    params.sessionManager.appendCustomEntry?.(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, {
      timestamp: params.now ?? Date.now(),
      runId: params.runId,
      sessionId: params.sessionId,
      phase: params.phase,
      ...(params.compactionOccurredThisAttempt ? { postCompaction: true } : {}),
    });
    return true;
  } catch (entryErr) {
    params.warn?.(`failed to persist bootstrap context marker: ${String(entryErr)}`);
    return false;
  }
}
