import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../agents/test-helpers/fast-coding-tools.js";
import {
  loadRunCronIsolatedAgentTurn,
  resetRunCronIsolatedAgentTurnHarness,
  resolveDeliveryTargetMock,
  resolveCronPayloadOutcomeMock,
  isCliProviderMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const RUN_TOOLS_ALLOW_TIMEOUT_MS = 300_000;

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "tools-allow",
      name: "Tools Allow",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "check allowed tools" },
      delivery: { mode: "none" },
    } as never,
    message: "check allowed tools",
    sessionKey: "cron:tools-allow",
  };
}

function makeParamsWithToolsAllow(toolsAllow: string[]) {
  const params = makeParams();
  const job = params.job as Record<string, unknown>;
  return {
    ...params,
    job: {
      ...job,
      payload: {
        kind: "agentTurn",
        message: "check allowed tools",
        toolsAllow,
      },
    } as never,
  };
}

function makeParamsWithMessageToolsAllow(message: string, toolsAllow: string[]) {
  const params = makeParams();
  const job = params.job as Record<string, unknown>;
  return {
    ...params,
    message,
    job: {
      ...job,
      payload: {
        kind: "agentTurn",
        message,
        toolsAllow,
      },
    } as never,
  };
}

function requireEmbeddedAgentCall(): {
  jobId?: string;
  toolsAllow?: string[];
} {
  const call = runEmbeddedAgentMock.mock.calls[0]?.[0] as
    | {
        jobId?: string;
        toolsAllow?: string[];
      }
    | undefined;
  if (!call) {
    throw new Error("Expected embedded OpenClaw agent call for toolsAllow passthrough");
  }
  return call;
}

function requireCliAgentCall(): {
  jobId?: string;
  toolsAllow?: string[];
} {
  const call = runCliAgentMock.mock.calls[0]?.[0] as
    | {
        jobId?: string;
        toolsAllow?: string[];
      }
    | undefined;
  if (!call) {
    throw new Error("Expected CLI OpenClaw agent call for toolsAllow passthrough");
  }
  return call;
}

describe("runCronIsolatedAgentTurn toolsAllow passthrough", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      channel: "forum",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
  });

  afterEach(() => {
    if (previousFastTestEnv == null) {
      vi.unstubAllEnvs();
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    vi.stubEnv("OPENCLAW_TEST_FAST", previousFastTestEnv);
  });

  it(
    "passes through isolated cron toolsAllow=cron self-removal path",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["cron"]));

      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.jobId).toBe("tools-allow");
      expect(call.toolsAllow).toEqual(["cron"]);
    },
  );

  it(
    "preserves cron toolsAllow casing for downstream policy resolution",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow([" CRON "]));

      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.jobId).toBe("tools-allow");
      expect(call.toolsAllow).toEqual([" CRON "]);
    },
  );

  it(
    "passes through non-cron toolsAllow entries",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["maniple__check_idle_workers"]));

      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.toolsAllow).toEqual(["maniple__check_idle_workers"]);
    },
  );

  it(
    "passes toolsAllow to CLI cron runs so the CLI runner can fail closed",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      isCliProviderMock.mockReturnValue(true);
      runCliAgentMock.mockResolvedValue({
        payloads: [{ text: "test output" }],
        meta: { agentMeta: {} },
      });

      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["exec"]));

      expect(runCliAgentMock).toHaveBeenCalledTimes(1);
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      const call = requireCliAgentCall();
      expect(call.jobId).toBe("tools-allow");
      expect(call.toolsAllow).toEqual(["exec"]);
    },
  );

  it(
    "runs isolated exec cron commands directly when the payload explicitly asks to execute them",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await fs.mkdir("/tmp/workspace", { recursive: true });

      const result = await runCronIsolatedAgentTurn(
        makeParamsWithMessageToolsAllow(
          "Run cron smoke: execute `node -e \"console.log('cron-direct-ok')\"` and report output.",
          ["exec"],
        ),
      );

      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(runCliAgentMock).not.toHaveBeenCalled();
      expect(result.status).toBe("ok");
      const outcomeCall = resolveCronPayloadOutcomeMock.mock.calls.at(-1)?.[0] as
        | { payloads?: Array<{ text?: string; isError?: boolean }> }
        | undefined;
      expect(outcomeCall?.payloads?.[0]?.isError).toBe(false);
      expect(outcomeCall?.payloads?.[0]?.text).toContain("Direct cron shell execution completed");
      expect(outcomeCall?.payloads?.[0]?.text).toContain("cron-direct-ok");
    },
  );
});
