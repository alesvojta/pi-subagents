import { parseEnvString } from "../launch/env.ts";
import { resolveHerdrPlacementPolicy, resolveRexPlacementPolicy, resolveZellijPlacementPolicy } from "../mux.ts";
import type { PersistedSubagentLaunchMetadata } from "../session/session-files.ts";

// A resume prefers the agent's own env value, then the current parent default,
// then the policy persisted at launch. The parent reads placement before the
// child pane exists, so these are parent-side exceptions to the child env contract.

export function resolveResumeHerdrPlacementPolicy(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	parentPolicy: string | undefined,
): ReturnType<typeof resolveHerdrPlacementPolicy> | undefined {
	const agentPolicy = parseEnvString(launchMetadata?.env).PI_SUBAGENT_HERDR_PLACEMENT;
	if (agentPolicy !== undefined) return resolveHerdrPlacementPolicy(agentPolicy);
	if (parentPolicy !== undefined) return resolveHerdrPlacementPolicy(parentPolicy);
	return launchMetadata?.herdrPlacementPolicy;
}

export function resolveResumeRexPlacementPolicy(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	parentPolicy: string | undefined,
): ReturnType<typeof resolveRexPlacementPolicy> | undefined {
	const agentPolicy = parseEnvString(launchMetadata?.env).PI_SUBAGENT_REX_PLACEMENT;
	if (agentPolicy !== undefined) return resolveRexPlacementPolicy(agentPolicy);
	if (parentPolicy !== undefined) return resolveRexPlacementPolicy(parentPolicy);
	return launchMetadata?.rexPlacementPolicy;
}

export function resolveResumeZellijPlacementPolicy(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	parentPolicy: string | undefined,
): ReturnType<typeof resolveZellijPlacementPolicy> | undefined {
	const agentPolicy = parseEnvString(launchMetadata?.env).PI_SUBAGENT_ZELLIJ_PLACEMENT;
	if (agentPolicy !== undefined) return resolveZellijPlacementPolicy(agentPolicy);
	if (parentPolicy !== undefined) return resolveZellijPlacementPolicy(parentPolicy);
	return launchMetadata?.zellijPlacementPolicy;
}
