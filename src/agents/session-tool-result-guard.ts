import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
} from "../plugins/types.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { formatContextLimitTruncationNotice } from "./pi-embedded-runner/tool-result-context-guard.js";
import {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  truncateToolResultMessage,
} from "./pi-embedded-runner/tool-result-truncation.js";

/**
 * Content block types that represent tool calls.
 * Used to strip partial tool calls from aborted/error assistant messages.
 */
const TOOL_CALL_BLOCK_TYPES = new Set(["toolCall", "toolUse", "functionCall", "function_call"]);

/**
 * When a stream is interrupted (stopReason "aborted" or "error"), the assistant
 * message may contain partial tool call blocks (e.g., missing arguments, truncated JSON).
 * If persisted as-is, these orphaned tool_use blocks force repairToolUseResultPairing
 * to synthesize missing results on every subsequent replay — wasting context tokens
 * and causing repetitive synthetic error results.
 *
 * This function strips tool-call-type blocks from the assistant message content,
 * preserving text, thinking, and other non-tool blocks. This prevents orphaned
 * tool calls from entering the session JSONL during stream interruptions.
 */
function stripToolCallBlocks(message: AgentMessage): AgentMessage {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return message;
  }
  const filtered = content.filter((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    const type = (block as { type?: unknown }).type;
    return typeof type !== "string" || !TOOL_CALL_BLOCK_TYPES.has(type);
  });
  if (filtered.length === content.length) {
    return message;
  }
  return { ...message, content: filtered } as AgentMessage;
}
import {
  getRawSessionAppendMessage,
  setRawSessionAppendMessage,
} from "./session-raw-append-message.js";
import { createPendingToolCallState } from "./session-tool-result-state.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";

/**
 * Truncate oversized text content blocks in a tool result message.
 * Returns the original message if under the limit, or a new message with
 * truncated text blocks otherwise.
 */
function capToolResultSize(msg: AgentMessage): AgentMessage {
  if ((msg as { role?: string }).role !== "toolResult") {
    return msg;
  }
  return truncateToolResultMessage(msg, DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS, {
    suffix: (truncatedChars) => formatContextLimitTruncationNotice(truncatedChars),
    minKeepChars: 2_000,
  });
}

function normalizePersistedToolResultName(
  message: AgentMessage,
  fallbackName?: string,
): AgentMessage {
  if ((message as { role?: unknown }).role !== "toolResult") {
    return message;
  }
  const toolResult = message as Extract<AgentMessage, { role: "toolResult" }>;
  const rawToolName = (toolResult as { toolName?: unknown }).toolName;
  const normalizedToolName = normalizeOptionalString(rawToolName);
  if (normalizedToolName) {
    if (rawToolName === normalizedToolName) {
      return toolResult;
    }
    return { ...toolResult, toolName: normalizedToolName };
  }

  const normalizedFallback = normalizeOptionalString(fallbackName);
  if (normalizedFallback) {
    return { ...toolResult, toolName: normalizedFallback };
  }

  if (typeof rawToolName === "string") {
    return { ...toolResult, toolName: "unknown" };
  }
  return toolResult;
}

export { getRawSessionAppendMessage };

export function installSessionToolResultGuard(
  sessionManager: SessionManager,
  opts?: {
    /** Optional session key for transcript update broadcasts. */
    sessionKey?: string;
    /**
     * Optional transform applied to any message before persistence.
     */
    transformMessageForPersistence?: (message: AgentMessage) => AgentMessage;
    /**
     * Optional, synchronous transform applied to toolResult messages *before* they are
     * persisted to the session transcript.
     */
    transformToolResultForPersistence?: (
      message: AgentMessage,
      meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
    ) => AgentMessage;
    /**
     * Whether to synthesize missing tool results to satisfy strict providers.
     * Defaults to true.
     */
    allowSyntheticToolResults?: boolean;
    /**
     * Optional set/list of tool names accepted for assistant toolCall/toolUse blocks.
     * When set, tool calls with unknown names are dropped before persistence.
     */
    allowedToolNames?: Iterable<string>;
    /**
     * Synchronous hook invoked before any message is written to the session JSONL.
     * If the hook returns { block: true }, the message is silently dropped.
     * If it returns { message }, the modified message is written instead.
     */
    beforeMessageWriteHook?: (
      event: PluginHookBeforeMessageWriteEvent,
    ) => PluginHookBeforeMessageWriteResult | undefined;
  },
): {
  flushPendingToolResults: (options?: { force?: boolean }) => void;
  flushPendingToolResultsForced: () => void;
  clearPendingToolResults: () => void;
  getPendingIds: () => string[];
} {
  const originalAppend = getRawSessionAppendMessage(sessionManager);
  setRawSessionAppendMessage(sessionManager, originalAppend);
  const pendingState = createPendingToolCallState();
  const persistMessage = (message: AgentMessage) => {
    const transformer = opts?.transformMessageForPersistence;
    return transformer ? transformer(message) : message;
  };

  const persistToolResult = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ) => {
    const transformer = opts?.transformToolResultForPersistence;
    return transformer ? transformer(message, meta) : message;
  };

  const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;
  const beforeWrite = opts?.beforeMessageWriteHook;

  /**
   * Run the before_message_write hook. Returns the (possibly modified) message,
   * or null if the message should be blocked.
   */
  const applyBeforeWriteHook = (msg: AgentMessage): AgentMessage | null => {
    if (!beforeWrite) {
      return msg;
    }
    const result = beforeWrite({ message: msg });
    if (result?.block) {
      return null;
    }
    if (result?.message) {
      return result.message;
    }
    return msg;
  };

  const flushPendingToolResults = (options?: { force?: boolean }) => {
    if (pendingState.size() === 0) {
      return;
    }
    // When `force` is true, always insert synthetic results regardless of provider
    // policy. This is critical for session cleanup: when the agent doesn't become
    // idle within the timeout, we must still persist synthetic results to prevent
    // permanently orphaned tool_use blocks in the JSONL transcript. Without this,
    // every subsequent replay would need to re-run repairToolUseResultPairing,
    // wasting context tokens and risking API 400 errors if repair has edge cases.
    const shouldInsertSynthetics = allowSyntheticToolResults || options?.force === true;
    if (shouldInsertSynthetics) {
      for (const [id, name] of pendingState.entries()) {
        const synthetic = makeMissingToolResult({ toolCallId: id, toolName: name });
        const flushed = applyBeforeWriteHook(
          persistToolResult(persistMessage(synthetic), {
            toolCallId: id,
            toolName: name,
            isSynthetic: true,
          }),
        );
        if (flushed) {
          originalAppend(flushed as never);
        }
      }
    }
    pendingState.clear();
  };

  /**
   * Force-flush pending tool results with synthetic results, regardless of
   * provider policy. Used during session cleanup to prevent permanently
   * orphaned tool_use blocks.
   */
  const flushPendingToolResultsForced = () => {
    flushPendingToolResults({ force: true });
  };

  const clearPendingToolResults = () => {
    pendingState.clear();
  };

  const guardedAppend = (message: AgentMessage) => {
    let nextMessage = message;
    const role = (message as { role?: unknown }).role;
    if (role === "assistant") {
      const sanitized = sanitizeToolCallInputs([message], {
        allowedToolNames: opts?.allowedToolNames,
      });
      if (sanitized.length === 0) {
        if (pendingState.shouldFlushForSanitizedDrop()) {
          flushPendingToolResults();
        }
        return undefined;
      }
      nextMessage = sanitized[0];
    }
    const nextRole = (nextMessage as { role?: unknown }).role;

    if (nextRole === "toolResult") {
      const id = extractToolResultId(nextMessage as Extract<AgentMessage, { role: "toolResult" }>);
      const toolName = id ? pendingState.getToolName(id) : undefined;
      // Detect orphan tool results: results that arrive without a matching pending
      // tool call. These will be dropped by repairToolUseResultPairing on replay,
      // so log a warning for diagnostics. The result is still persisted to avoid
      // data loss in case the pending state was cleared prematurely.
      if (id && !pendingState.has(id)) {
        const sessionKey = opts?.sessionKey ?? "unknown";
        console.warn(
          `[openclaw] orphan tool result: sessionKey=${sessionKey} toolCallId=${id} ` +
          `has no matching pending tool call. Result persisted but will be dropped on replay.`,
        );
      }
      if (id) {
        pendingState.delete(id);
      }
      const normalizedToolResult = normalizePersistedToolResultName(nextMessage, toolName);
      // Apply hard size cap before persistence to prevent oversized tool results
      // from consuming the entire context window on subsequent LLM calls.
      const capped = capToolResultSize(persistMessage(normalizedToolResult));
      const persisted = applyBeforeWriteHook(
        persistToolResult(capped, {
          toolCallId: id ?? undefined,
          toolName,
          isSynthetic: false,
        }),
      );
      if (!persisted) {
        return undefined;
      }
      return originalAppend(persisted as never);
    }

    // When stopReason is "error" or "aborted", the tool_use blocks may be incomplete
    // (missing IDs, truncated arguments, partial JSON). Strip them before persistence
  // to prevent orphaned tool_use blocks from entering the session JSONL, which would
  // force repairToolUseResultPairing to synthesize missing results on every subsequent
  // replay, wasting context and causing repetitive synthetic error results.
    // This also prevents API 400 errors: "unexpected tool_use_id found in tool_result blocks"
    const stopReason = (nextMessage as { stopReason?: string }).stopReason;
    if (nextRole === "assistant" && (stopReason === "aborted" || stopReason === "error")) {
      nextMessage = stripToolCallBlocks(nextMessage);
    }
    const toolCalls =
      nextRole === "assistant" && stopReason !== "aborted" && stopReason !== "error"
        ? extractToolCallsFromAssistant(nextMessage as Extract<AgentMessage, { role: "assistant" }>)
        : [];

    // Always clear pending tool call state before appending non-tool-result messages.
    // flushPendingToolResults() only inserts synthetic results when allowSyntheticToolResults
    // is true; it always clears the pending map. Without this, providers that disable
    // synthetic results (e.g. OpenAI) accumulate stale pending state when a user message
    // interrupts in-flight tool calls, leaving orphaned tool_use blocks in the transcript
    // that cause API 400 errors on subsequent requests.
    if (pendingState.shouldFlushBeforeNonToolResult(nextRole, toolCalls.length)) {
      flushPendingToolResults();
    }
    // If new tool calls arrive while older ones are pending, flush the old ones first.
    if (pendingState.shouldFlushBeforeNewToolCalls(toolCalls.length)) {
      flushPendingToolResults();
    }

    const finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));
    if (!finalMessage) {
      return undefined;
    }
    const result = originalAppend(finalMessage as never);

    const sessionFile = (
      sessionManager as { getSessionFile?: () => string | null }
    ).getSessionFile?.();
    if (sessionFile) {
      emitSessionTranscriptUpdate({
        sessionFile,
        sessionKey: opts?.sessionKey,
        message: finalMessage,
        messageId: typeof result === "string" ? result : undefined,
      });
    }

    if (toolCalls.length > 0) {
      pendingState.trackToolCalls(toolCalls);
    }

    return result;
  };

  // Monkey-patch appendMessage with our guarded version.
  sessionManager.appendMessage = guardedAppend as SessionManager["appendMessage"];

  return {
    flushPendingToolResults,
    flushPendingToolResultsForced,
    clearPendingToolResults,
    getPendingIds: pendingState.getPendingIds,
  };
}
