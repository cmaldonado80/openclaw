import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { OpenClawConfig } from "../api.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";

const log = createSubsystemLogger("memory-wiki/corpus-supplement");
const CORPUS_SUPPLEMENT_TIMEOUT_MS = 2_000;

async function settleCorpusSupplement<T>(params: {
  operation: Promise<T>;
  fallback: T;
  label: "search" | "get";
}): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      params.operation,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          log.warn(`memory-wiki corpus ${params.label} exceeded time budget`, {
            timeoutMs: CORPUS_SUPPLEMENT_TIMEOUT_MS,
          });
          resolve(params.fallback);
        }, CORPUS_SUPPLEMENT_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    log.warn(`memory-wiki corpus ${params.label} failed; continuing without supplement`, {
      error: String(error),
    });
    return params.fallback;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function createWikiCorpusSupplement(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
}) {
  return {
    search: async (input: { query: string; maxResults?: number; agentSessionKey?: string }) =>
      await settleCorpusSupplement({
        operation: searchMemoryWiki({
          config: params.config,
          appConfig: params.appConfig,
          agentSessionKey: input.agentSessionKey,
          query: input.query,
          maxResults: input.maxResults,
          searchBackend: "local",
          searchCorpus: "wiki",
        }),
        fallback: [],
        label: "search",
      }),
    get: async (input: {
      lookup: string;
      fromLine?: number;
      lineCount?: number;
      agentSessionKey?: string;
    }) =>
      await settleCorpusSupplement({
        operation: getMemoryWikiPage({
          config: params.config,
          appConfig: params.appConfig,
          agentSessionKey: input.agentSessionKey,
          lookup: input.lookup,
          fromLine: input.fromLine,
          lineCount: input.lineCount,
          searchBackend: "local",
          searchCorpus: "wiki",
        }),
        fallback: null,
        label: "get",
      }),
  };
}
