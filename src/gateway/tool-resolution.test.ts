import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyToolPolicyPipeline: vi.fn(({ tools }: { tools: unknown[] }) => tools),
  buildDefaultToolPolicyPipelineSteps: vi.fn(() => []),
  collectExplicitAllowlist: vi.fn(() => []),
  createOpenClawTools: vi.fn(() => []),
  getPluginToolMeta: vi.fn(),
  loadSessionEntry: vi.fn(),
  logWarn: vi.fn(),
  mergeAlsoAllowPolicy: vi.fn((policy: unknown) => policy),
  resolveAgentWorkspaceDir: vi.fn(() => "/workspace-rudy"),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveEffectiveToolPolicy: vi.fn(() => ({
    agentId: "rudy",
    globalPolicy: undefined,
    globalProviderPolicy: undefined,
    agentPolicy: undefined,
    agentProviderPolicy: undefined,
    profile: "minimal",
    providerProfile: undefined,
    profileAlsoAllow: undefined,
    providerProfileAlsoAllow: undefined,
  })),
  resolveGroupToolPolicy: vi.fn(() => ({ allow: ["milenium-intelligence__*"] })),
  resolveSubagentToolPolicy: vi.fn(() => ({ allow: ["subagents"] })),
  resolveToolProfilePolicy: vi.fn(() => undefined),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: mocks.createOpenClawTools,
}));

vi.mock("../agents/pi-tools.policy.js", () => ({
  resolveEffectiveToolPolicy: mocks.resolveEffectiveToolPolicy,
  resolveGroupToolPolicy: mocks.resolveGroupToolPolicy,
  resolveSubagentToolPolicy: mocks.resolveSubagentToolPolicy,
}));

vi.mock("../agents/tool-policy-pipeline.js", () => ({
  applyToolPolicyPipeline: mocks.applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps: mocks.buildDefaultToolPolicyPipelineSteps,
}));

vi.mock("../agents/tool-policy.js", () => ({
  collectExplicitAllowlist: mocks.collectExplicitAllowlist,
  mergeAlsoAllowPolicy: mocks.mergeAlsoAllowPolicy,
  resolveToolProfilePolicy: mocks.resolveToolProfilePolicy,
}));

vi.mock("../logger.js", () => ({
  logWarn: mocks.logWarn,
}));

vi.mock("../plugins/tools.js", () => ({
  getPluginToolMeta: mocks.getPluginToolMeta,
}));

vi.mock("../security/dangerous-tools.js", () => ({
  DEFAULT_GATEWAY_HTTP_TOOL_DENY: [],
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

describe("resolveGatewayScopedTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => {
      if (sessionKey === "agent:rudy:subagent:child") {
        return {
          entry: {
            sessionId: "child",
            spawnedBy: "agent:rudy:whatsapp:group:fnb",
          },
        };
      }
      if (sessionKey === "agent:rudy:whatsapp:group:fnb") {
        return {
          entry: {
            sessionId: "parent",
            lastChannel: "whatsapp",
            lastAccountId: "acct-parent",
            groupId: "fnb",
            groupChannel: "Milenium F&B",
            space: "menu-intel",
          },
        };
      }
      throw new Error(`unexpected session key ${sessionKey}`);
    });
  });

  it("passes stored parent group lineage for isolated subagent sessions", () => {
    resolveGatewayScopedTools({
      cfg: {} as never,
      sessionKey: "agent:rudy:subagent:child",
      surface: "loopback",
    });

    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("agent:rudy:subagent:child");
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("agent:rudy:whatsapp:group:fnb");
    expect(mocks.resolveGroupToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:rudy:subagent:child",
        spawnedBy: "agent:rudy:whatsapp:group:fnb",
        messageProvider: "whatsapp",
        accountId: "acct-parent",
        groupId: "fnb",
        groupChannel: "Milenium F&B",
        groupSpace: "menu-intel",
      }),
    );
    expect(mocks.createOpenClawTools).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionKey: "agent:rudy:subagent:child",
        agentChannel: "whatsapp",
        agentAccountId: "acct-parent",
      }),
    );
  });
});
