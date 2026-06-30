import { describe, expect, it, vi } from "vitest";
import type { BoundDeliveryRouterInput } from "../infra/outbound/bound-delivery-router.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import { resolveSubagentCompletionOrigin } from "./subagent-announce-delivery.js";

const resolveDestinationMock = vi.fn();

vi.mock("./subagent-announce-delivery.runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./subagent-announce-delivery.runtime.js")>();
  return {
    ...actual,
    createBoundDeliveryRouter: () => ({
      resolveDestination: (input: BoundDeliveryRouterInput) => resolveDestinationMock(input),
    }),
    getGlobalHookRunner: () => ({ hasHooks: () => false }),
  };
});

describe("resolveAnnounceOrigin telegram forum topics", () => {
  it("preserves stored forum topic thread ids when requester origin omits one for the same chat", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "telegram",
          lastTo: "telegram:-1001234567890:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "telegram",
          to: "telegram:-1001234567890",
        },
      ),
    ).toEqual({
      channel: "telegram",
      to: "telegram:-1001234567890",
      threadId: 99,
    });
  });

  it("preserves stored forum topic thread ids for legacy group-prefixed requester targets", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "telegram",
          lastTo: "telegram:-1001234567890:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "telegram",
          to: "group:-1001234567890",
        },
      ),
    ).toEqual({
      channel: "telegram",
      to: "group:-1001234567890",
      threadId: 99,
    });
  });

  it("still strips stale thread ids when the stored telegram route points at a different chat", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "telegram",
          lastTo: "telegram:-1009999999999:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "telegram",
          to: "telegram:-1001234567890",
        },
      ),
    ).toEqual({
      channel: "telegram",
      to: "telegram:-1001234567890",
    });
  });
});

describe("resolveSubagentCompletionOrigin", () => {
  it("recovers a missing webchat target from the requester session binding", async () => {
    resolveDestinationMock.mockReset();
    resolveDestinationMock.mockImplementation((input: BoundDeliveryRouterInput) => {
      if (input.targetSessionKey === "agent:main:main") {
        return {
          mode: "bound",
          reason: "single-active-binding",
          binding: {
            bindingId: "binding-webchat-current",
            targetSessionKey: "agent:main:main",
            status: "active",
            placement: "current",
            conversation: {
              channel: "webchat",
              accountId: "default",
              conversationId: "conversation-123",
            },
            boundAt: 1,
            updatedAt: 1,
          },
        };
      }
      return { mode: "fallback", reason: "no-active-binding", binding: null };
    });

    await expect(
      resolveSubagentCompletionOrigin({
        childSessionKey: "agent:main:subagent:worker",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "webchat",
          accountId: "default",
        },
        expectsCompletionMessage: true,
      }),
    ).resolves.toEqual({
      channel: "webchat",
      accountId: "default",
      to: "channel:conversation-123",
    });
  });

  it("fails closed when a webchat completion has no target and no binding", async () => {
    resolveDestinationMock.mockReset();
    resolveDestinationMock.mockReturnValue({
      mode: "fallback",
      reason: "no-active-binding",
      binding: null,
    });

    await expect(
      resolveSubagentCompletionOrigin({
        childSessionKey: "agent:main:subagent:worker",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "webchat",
          accountId: "default",
        },
        expectsCompletionMessage: true,
      }),
    ).rejects.toThrow(/task completion delivery target unresolved/);
  });
});
