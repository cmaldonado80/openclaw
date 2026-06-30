import { describe, expect, it } from "vitest";
import { FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE } from "../../bootstrap-files.js";
import {
  appendFullBootstrapContextMarker,
  shouldPersistCompletedBootstrapTurn,
} from "./attempt.thread-helpers.js";

describe("runEmbeddedAttempt bootstrap completion marker", () => {
  it("keeps marker persistence enabled for clean sessions_yield exits", () => {
    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: true,
        promptError: undefined,
        aborted: false,
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: false,
      }),
    ).toBe(true);
  });

  it("skips marker persistence when recording is disabled", () => {
    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: false,
        promptError: undefined,
        aborted: false,
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: false,
      }),
    ).toBe(false);
  });

  it("skips marker persistence when the attempt aborted", () => {
    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: true,
        promptError: undefined,
        aborted: true,
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: false,
      }),
    ).toBe(false);
  });

  it("skips marker persistence for prompt errors and compaction-side outcomes", () => {
    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: true,
        promptError: new Error("prompt failed"),
        aborted: false,
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: false,
      }),
    ).toBe(false);

    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: true,
        promptError: undefined,
        aborted: false,
        timedOutDuringCompaction: true,
        compactionOccurredThisAttempt: false,
      }),
    ).toBe(false);

    expect(
      shouldPersistCompletedBootstrapTurn({
        shouldRecordCompletedBootstrapTurn: true,
        promptError: undefined,
        aborted: false,
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: true,
      }),
    ).toBe(false);
  });

  it("persists the full-bootstrap marker when the prompt is submitted", () => {
    const calls: Array<[string, unknown]> = [];
    const persisted = appendFullBootstrapContextMarker({
      sessionManager: {
        appendCustomEntry: (customType, data) => {
          calls.push([customType, data]);
        },
      },
      runId: "run-1",
      sessionId: "session-1",
      phase: "prompt-start",
      now: 123,
    });

    expect(persisted).toBe(true);
    expect(calls).toEqual([
      [
        FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
        {
          timestamp: 123,
          runId: "run-1",
          sessionId: "session-1",
          phase: "prompt-start",
        },
      ],
    ]);
  });

  it("reports marker persistence failures without throwing", () => {
    const warnings: string[] = [];
    const persisted = appendFullBootstrapContextMarker({
      sessionManager: {
        appendCustomEntry: () => {
          throw new Error("disk busy");
        },
      },
      runId: "run-1",
      sessionId: "session-1",
      phase: "prompt-start",
      now: 123,
      warn: (message) => warnings.push(message),
    });

    expect(persisted).toBe(false);
    expect(warnings).toEqual(["failed to persist bootstrap context marker: Error: disk busy"]);
  });
});
