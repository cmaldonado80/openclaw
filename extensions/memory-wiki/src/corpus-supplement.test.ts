import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";

const queryMocks = vi.hoisted(() => ({
  getMemoryWikiPage: vi.fn(),
  searchMemoryWiki: vi.fn(),
}));

vi.mock("./query.js", () => queryMocks);

import { createWikiCorpusSupplement } from "./corpus-supplement.js";

describe("memory-wiki corpus supplement", () => {
  beforeEach(() => {
    vi.useRealTimers();
    queryMocks.getMemoryWikiPage.mockReset();
    queryMocks.searchMemoryWiki.mockReset();
  });

  it("returns fast wiki search results unchanged", async () => {
    queryMocks.searchMemoryWiki.mockResolvedValue([
      {
        corpus: "wiki",
        path: "syntheses/example.md",
        title: "Example",
        kind: "synthesis",
        score: 1,
        snippet: "example",
      },
    ]);
    const supplement = createWikiCorpusSupplement({
      config: resolveMemoryWikiConfig(undefined, { homedir: "/tmp" }),
    });

    await expect(supplement.search({ query: "example" })).resolves.toHaveLength(1);
  });

  it("bounds a slow wiki search so shared memory recall can continue", async () => {
    vi.useFakeTimers();
    queryMocks.searchMemoryWiki.mockReturnValue(new Promise(() => undefined));
    const supplement = createWikiCorpusSupplement({
      config: resolveMemoryWikiConfig(undefined, { homedir: "/tmp" }),
    });

    const result = supplement.search({ query: "slow" });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toEqual([]);
  });

  it("bounds a slow wiki get so shared memory reads can continue", async () => {
    vi.useFakeTimers();
    queryMocks.getMemoryWikiPage.mockReturnValue(new Promise(() => undefined));
    const supplement = createWikiCorpusSupplement({
      config: resolveMemoryWikiConfig(undefined, { homedir: "/tmp" }),
    });

    const result = supplement.get({ lookup: "slow" });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toBeNull();
  });

  it("isolates wiki errors from the shared memory tool", async () => {
    queryMocks.searchMemoryWiki.mockRejectedValue(new Error("icloud unavailable"));
    const supplement = createWikiCorpusSupplement({
      config: resolveMemoryWikiConfig(undefined, { homedir: "/tmp" }),
    });

    await expect(supplement.search({ query: "example" })).resolves.toEqual([]);
  });
});
