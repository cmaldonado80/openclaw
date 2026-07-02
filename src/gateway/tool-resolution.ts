import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicy,
} from "../agents/pi-tools.policy.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../agents/tool-policy-pipeline.js";
import {
  collectExplicitAllowlist,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
} from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "../security/dangerous-tools.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { loadSessionEntry } from "./session-utils.js";

export type GatewayScopedToolSurface = "http" | "loopback";

type GatewayScopedToolLineage = {
  spawnedBy?: string;
  messageProvider?: string;
  accountId?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
};

function resolveStoredSessionLineage(sessionKey: string): GatewayScopedToolLineage {
  if (!isSubagentSessionKey(sessionKey)) {
    return {};
  }
  try {
    const loaded = loadSessionEntry(sessionKey);
    const entry = loaded.entry;
    const spawnedBy = normalizeOptionalString(entry?.spawnedBy ?? entry?.parentSessionKey);
    let parentEntry: typeof entry | undefined;
    if (spawnedBy) {
      try {
        parentEntry = loadSessionEntry(spawnedBy).entry;
      } catch {
        parentEntry = undefined;
      }
    }
    return {
      spawnedBy,
      messageProvider:
        normalizeOptionalString(entry?.lastChannel) ??
        normalizeOptionalString(entry?.channel) ??
        normalizeOptionalString(entry?.origin?.provider) ??
        normalizeOptionalString(parentEntry?.lastChannel) ??
        normalizeOptionalString(parentEntry?.channel) ??
        normalizeOptionalString(parentEntry?.origin?.provider),
      accountId:
        normalizeOptionalString(entry?.lastAccountId) ??
        normalizeOptionalString(entry?.origin?.accountId) ??
        normalizeOptionalString(parentEntry?.lastAccountId) ??
        normalizeOptionalString(parentEntry?.origin?.accountId),
      groupId:
        normalizeOptionalString(entry?.groupId) ?? normalizeOptionalString(parentEntry?.groupId),
      groupChannel:
        normalizeOptionalString(entry?.groupChannel) ??
        normalizeOptionalString(parentEntry?.groupChannel),
      groupSpace:
        normalizeOptionalString(entry?.space) ?? normalizeOptionalString(parentEntry?.space),
    };
  } catch {
    return {};
  }
}

export function resolveGatewayScopedTools(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  messageProvider?: string;
  accountId?: string;
  spawnedBy?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  agentTo?: string;
  agentThreadId?: string;
  allowGatewaySubagentBinding?: boolean;
  allowMediaInvokeCommands?: boolean;
  surface?: GatewayScopedToolSurface;
  excludeToolNames?: Iterable<string>;
  disablePluginTools?: boolean;
  senderIsOwner?: boolean;
}) {
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({ config: params.cfg, sessionKey: params.sessionKey });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
  const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );
  const storedLineage = resolveStoredSessionLineage(params.sessionKey);
  const messageProvider = params.messageProvider ?? storedLineage.messageProvider;
  const accountId = params.accountId ?? storedLineage.accountId;
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy ?? storedLineage.spawnedBy,
    messageProvider,
    groupId: params.groupId ?? storedLineage.groupId,
    groupChannel: params.groupChannel ?? storedLineage.groupChannel,
    groupSpace: params.groupSpace ?? storedLineage.groupSpace,
    accountId: accountId ?? null,
  });
  const subagentPolicy = isSubagentSessionKey(params.sessionKey)
    ? resolveSubagentToolPolicy(params.cfg)
    : undefined;
  const workspaceDir = resolveAgentWorkspaceDir(
    params.cfg,
    agentId ?? resolveDefaultAgentId(params.cfg),
  );

  const allTools = createOpenClawTools({
    agentSessionKey: params.sessionKey,
    agentChannel: messageProvider ?? undefined,
    agentAccountId: accountId,
    agentTo: params.agentTo,
    agentThreadId: params.agentThreadId,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    allowMediaInvokeCommands: params.allowMediaInvokeCommands,
    disablePluginTools: params.disablePluginTools,
    senderIsOwner: params.senderIsOwner,
    config: params.cfg,
    workspaceDir,
    pluginToolAllowlist: collectExplicitAllowlist([
      profilePolicy,
      providerProfilePolicy,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      subagentPolicy,
    ]),
  });

  const policyFiltered = applyToolPolicyPipeline({
    tools: allTools,
    toolMeta: (tool: AnyAgentTool) => getPluginToolMeta(tool),
    warn: logWarn,
    steps: [
      ...buildDefaultToolPolicyPipelineSteps({
        profilePolicy: profilePolicyWithAlsoAllow,
        profile,
        profileUnavailableCoreWarningAllowlist: profilePolicy?.allow,
        providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
        providerProfile,
        providerProfileUnavailableCoreWarningAllowlist: providerProfilePolicy?.allow,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        agentId,
      }),
      { policy: subagentPolicy, label: "subagent tools.allow" },
    ],
  });

  const surface = params.surface ?? "http";
  const gatewayToolsCfg = params.cfg.gateway?.tools;
  const defaultGatewayDeny =
    surface === "http"
      ? DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter((name) => !gatewayToolsCfg?.allow?.includes(name))
      : [];
  const gatewayDenySet = new Set([
    ...defaultGatewayDeny,
    ...(Array.isArray(gatewayToolsCfg?.deny) ? gatewayToolsCfg.deny : []),
    ...(params.excludeToolNames ? Array.from(params.excludeToolNames) : []),
  ]);

  return {
    agentId,
    tools: policyFiltered.filter((tool) => !gatewayDenySet.has(tool.name)),
  };
}
