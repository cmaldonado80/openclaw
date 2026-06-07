import Testing
@testable import OpenClaw

@MainActor
struct RootTabsPresentationTests {
    @Test func `quick setup does not present when gateway already configured`() {
        let shouldPresent = RootTabs.shouldPresentQuickSetup(
            quickSetupDismissed: false,
            showOnboarding: false,
            hasPresentedSheet: false,
            gatewayConnected: false,
            hasExistingGatewayConfig: true,
            discoveredGatewayCount: 1)

        #expect(!shouldPresent)
    }

    @Test func `quick setup presents for fresh install with discovered gateway`() {
        let shouldPresent = RootTabs.shouldPresentQuickSetup(
            quickSetupDismissed: false,
            showOnboarding: false,
            hasPresentedSheet: false,
            gatewayConnected: false,
            hasExistingGatewayConfig: false,
            discoveredGatewayCount: 1)

        #expect(shouldPresent)
    }

    @Test func `quick setup does not present when already connected`() {
        let shouldPresent = RootTabs.shouldPresentQuickSetup(
            quickSetupDismissed: false,
            showOnboarding: false,
            hasPresentedSheet: false,
            gatewayConnected: true,
            hasExistingGatewayConfig: false,
            discoveredGatewayCount: 1)

        #expect(!shouldPresent)
    }

    @Test func `command center readiness summarizes ready session control`() {
        let summary = CommandCenterTab.controlReadinessSummary(
            gatewayConnected: true,
            isOperatorConnected: true,
            issue: .none,
            activeSessionCount: 2)

        #expect(summary == "2 ready")
    }

    @Test func `command center readiness prioritizes blockers`() {
        let summary = CommandCenterTab.controlReadinessSummary(
            gatewayConnected: true,
            isOperatorConnected: true,
            issue: .unauthorized,
            activeSessionCount: 2)

        #expect(summary == "Needs attention")
    }

    @Test func `command center blocker text names auth and pairing actions`() {
        #expect(
            CommandCenterTab.gatewayBlockerText(
                issue: .tokenMissing,
                statusText: "Gateway token missing")
                == "Add a gateway auth token in Settings.")
        #expect(
            CommandCenterTab.gatewayBlockerText(
                issue: .pairingRequired(requestId: "abc"),
                statusText: "Pairing required")
                == "Pairing approval waiting for request abc.")
    }
}
