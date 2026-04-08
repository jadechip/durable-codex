function formatCurrentDate(nowMs, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(nowMs));
}

const AGENTS_MD_START_MARKER = "# AGENTS.md instructions for ";
const AGENTS_MD_END_MARKER = "</INSTRUCTIONS>";

const SANDBOX_MODE_TEXT = {
  dangerFullAccess:
    "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `danger-full-access`: No filesystem sandboxing - all commands are permitted. Network access is {{network_access}}.",
  workspaceWrite:
    "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `workspace-write`: The sandbox permits reading files, and editing files in `cwd` and `writable_roots`. Editing files in other directories requires approval. Network access is {{network_access}}.",
  readOnly:
    "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `read-only`: The sandbox only permits reading files. Network access is {{network_access}}.",
};

function resolveTimezone(thread) {
  if (typeof thread.timezone === "string" && thread.timezone) {
    return thread.timezone;
  }

  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function resolveCurrentDate(thread, nowMs, timezone) {
  if (typeof thread.currentDate === "string" && thread.currentDate) {
    return thread.currentDate;
  }

  return formatCurrentDate(nowMs, timezone);
}

function normalizeCollaborationMode(collaborationMode) {
  if (!collaborationMode || typeof collaborationMode !== "object" || Array.isArray(collaborationMode)) {
    return null;
  }

  return structuredClone(collaborationMode);
}

function networkFromSandbox(sandbox) {
  const networkValue = sandbox?.networkAccess;
  if (networkValue === false || networkValue === "disabled") {
    return {
      allowedDomains: [],
      deniedDomains: [],
    };
  }

  return null;
}

function writableRootsFromSandbox(sandbox) {
  if (!sandbox || typeof sandbox !== "object") {
    return [];
  }

  if (Array.isArray(sandbox.writableRoots)) {
    return sandbox.writableRoots.filter((value) => typeof value === "string");
  }

  return [];
}

function sandboxModeFromPolicy(sandbox) {
  if (!sandbox || typeof sandbox !== "object") {
    return "externalSandbox";
  }

  if (typeof sandbox.type === "string" && sandbox.type) {
    return sandbox.type;
  }

  return "externalSandbox";
}

function sandboxModeText(turnContext) {
  const mode = sandboxModeFromPolicy(turnContext.sandboxPolicy);
  const networkAccess =
    turnContext.sandboxPolicy?.networkAccess === false ||
    turnContext.sandboxPolicy?.networkAccess === "disabled"
      ? "restricted"
      : "enabled";
  const template = SANDBOX_MODE_TEXT[mode] ?? SANDBOX_MODE_TEXT.dangerFullAccess;
  return template.replace("{{network_access}}", networkAccess);
}

function approvalPolicyText(turnContext) {
  switch (turnContext.approvalPolicy) {
    case "never":
      return "Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected.";
    case "onFailure":
    case "on-failure":
      return "Approvals are your mechanism to get user consent to run shell commands without the sandbox. `approval_policy` is `on-failure`: The harness will allow all commands to run in the sandbox (if enabled), and failures will be escalated to the user for approval to run again without the sandbox.";
    case "unlessTrusted":
    case "unless-trusted":
      return "Approvals are your mechanism to get user consent to run shell commands without the sandbox. `approval_policy` is `unless-trusted`: The harness will escalate most commands for user approval, apart from a limited allowlist of safe \"read\" commands.";
    case "onRequest":
    case "on-request":
      return [
        "# Escalation Requests",
        "",
        "Commands are run outside the sandbox if they are approved by the user, or match an existing rule that allows it to run unrestricted.",
        "",
        "IMPORTANT: To request approval to execute a command that requires escalated privileges:",
        "",
        "- Provide the `sandbox_permissions` parameter with the value `\"require_escalated\"`.",
        "- Include a short question in `justification` describing the action.",
        "- Use `prefix_rule` only when the permission should cover similar future commands.",
      ].join("\n");
    default:
      return `Approval policy: ${turnContext.approvalPolicy}`;
  }
}

function buildPermissionsText(turnContext) {
  const lines = ["<permissions instructions>"];
  lines.push(sandboxModeText(turnContext));
  lines.push(approvalPolicyText(turnContext));

  const writableRoots = writableRootsFromSandbox(turnContext.sandboxPolicy);
  if (writableRoots.length === 1) {
    lines.push(`The writable root is \`${writableRoots[0]}\`.`);
  } else if (writableRoots.length > 1) {
    lines.push(`The writable roots are ${writableRoots.map((root) => `\`${root}\``).join(", ")}.`);
  }

  if (turnContext.approvalsReviewer === "guardian_subagent") {
    lines.push(
      "`approvals_reviewer` is `guardian_subagent`: Sandbox escalations with require_escalated will be reviewed for compliance with the policy. If a rejection happens, proceed only with a materially safer alternative or ask the user for approval.",
    );
  }

  lines.push("</permissions instructions>");
  return lines.join("\n");
}

function buildModelSwitchText(modelInstructions) {
  return [
    "<model_switch>",
    "The user was previously using a different model. Please continue the conversation according to the following instructions:",
    "",
    modelInstructions,
    "</model_switch>",
  ].join("\n");
}

function buildCollaborationModeText(collaborationMode) {
  const instructions =
    collaborationMode?.settings?.developerInstructions ??
    collaborationMode?.developerInstructions ??
    null;

  if (typeof instructions !== "string" || !instructions.trim()) {
    return null;
  }

  return `<collaboration_mode>${instructions}</collaboration_mode>`;
}

function buildPersonalityText(personalityMessage) {
  if (typeof personalityMessage !== "string" || !personalityMessage.trim()) {
    return null;
  }

  return `<personality_spec> The user has requested a new communication style. Future messages should adhere to the following personality: \n${personalityMessage} </personality_spec>`;
}

function buildEnvironmentContextText({
  cwd = null,
  shell = "zsh",
  currentDate = null,
  timezone = null,
  network = null,
}) {
  const lines = [];

  if (cwd) {
    lines.push(`  <cwd>${cwd}</cwd>`);
  }
  lines.push(`  <shell>${shell}</shell>`);
  if (currentDate) {
    lines.push(`  <current_date>${currentDate}</current_date>`);
  }
  if (timezone) {
    lines.push(`  <timezone>${timezone}</timezone>`);
  }
  if (network) {
    lines.push("  <network enabled=\"true\">");
    for (const domain of network.allowedDomains ?? []) {
      lines.push(`    <allowed>${domain}</allowed>`);
    }
    for (const domain of network.deniedDomains ?? []) {
      lines.push(`    <denied>${domain}</denied>`);
    }
    lines.push("  </network>");
  }

  return `<environment_context>\n${lines.join("\n")}\n</environment_context>`;
}

function buildDeveloperMessage(textSections) {
  if (!Array.isArray(textSections) || textSections.length === 0) {
    return null;
  }

  return {
    type: "message",
    role: "developer",
    content: textSections.map((text) => ({
      type: "input_text",
      text,
    })),
  };
}

function buildContextualUserMessage(textSections) {
  if (!Array.isArray(textSections) || textSections.length === 0) {
    return null;
  }

  return {
    type: "message",
    role: "user",
    content: textSections.map((text) => ({
      type: "input_text",
      text,
    })),
  };
}

function serializeUserInstructions(text, cwd) {
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }

  return `${AGENTS_MD_START_MARKER}${cwd}\n\n<INSTRUCTIONS>\n${text}\n${AGENTS_MD_END_MARKER}`;
}

function environmentChanged(previous, next) {
  if (!previous) {
    return true;
  }

  return (
    previous.cwd !== next.cwd ||
    previous.currentDate !== next.currentDate ||
    previous.timezone !== next.timezone ||
    JSON.stringify(previous.network ?? null) !== JSON.stringify(next.network ?? null)
  );
}

export function createTurnContext(thread, { nowMs }) {
  const timezone = resolveTimezone(thread);
  const currentDate = resolveCurrentDate(thread, nowMs, timezone);

  return {
    cwd: thread.cwd,
    currentDate,
    timezone,
    approvalPolicy: thread.approvalPolicy,
    approvalsReviewer: thread.approvalsReviewer,
    sandboxPolicy: structuredClone(thread.sandbox),
    model: thread.model,
    personality: thread.personality ?? null,
    collaborationMode: normalizeCollaborationMode(thread.collaborationMode),
    realtimeActive: false,
    effort: thread.reasoningEffort ?? null,
    summary: thread.reasoningSummary ?? "auto",
    userInstructions: thread.userInstructions ?? null,
    developerInstructions: thread.developerInstructions ?? null,
    shell: typeof thread.shell === "string" && thread.shell ? thread.shell : "zsh",
    network: networkFromSandbox(thread.sandbox),
  };
}

export function buildInitialContextMessages({
  previousTurnSettings,
  turnContext,
  modelSwitchInstructions = null,
  personalityMessage = null,
}) {
  const developerSections = [];
  const contextualUserSections = [];

  if (previousTurnSettings?.model && previousTurnSettings.model !== turnContext.model && modelSwitchInstructions) {
    developerSections.push(buildModelSwitchText(modelSwitchInstructions));
  }

  developerSections.push(buildPermissionsText(turnContext));

  if (typeof turnContext.developerInstructions === "string" && turnContext.developerInstructions) {
    developerSections.push(turnContext.developerInstructions);
  }

  const collaborationText = buildCollaborationModeText(turnContext.collaborationMode);
  if (collaborationText) {
    developerSections.push(collaborationText);
  }

  const personalityText = buildPersonalityText(personalityMessage);
  if (personalityText) {
    developerSections.push(personalityText);
  }

  const serializedUserInstructions = serializeUserInstructions(turnContext.userInstructions, turnContext.cwd);
  if (serializedUserInstructions) {
    contextualUserSections.push(serializedUserInstructions);
  }

  contextualUserSections.push(buildEnvironmentContextText(turnContext));

  const items = [];
  const developerMessage = buildDeveloperMessage(developerSections);
  if (developerMessage) {
    items.push(developerMessage);
  }
  const contextualUserMessage = buildContextualUserMessage(contextualUserSections);
  if (contextualUserMessage) {
    items.push(contextualUserMessage);
  }

  return items;
}

export function buildContextUpdateMessages({
  previousContext,
  previousTurnSettings,
  turnContext,
  modelSwitchInstructions = null,
  personalityMessage = null,
}) {
  const developerSections = [];
  const contextualUserSections = [];

  if (previousTurnSettings?.model && previousTurnSettings.model !== turnContext.model && modelSwitchInstructions) {
    developerSections.push(buildModelSwitchText(modelSwitchInstructions));
  }

  if (
    previousContext &&
    (
      previousContext.approvalPolicy !== turnContext.approvalPolicy ||
      JSON.stringify(previousContext.sandboxPolicy) !== JSON.stringify(turnContext.sandboxPolicy)
    )
  ) {
    developerSections.push(buildPermissionsText(turnContext));
  }

  if (
    previousContext &&
    JSON.stringify(previousContext.collaborationMode ?? null) !== JSON.stringify(turnContext.collaborationMode ?? null)
  ) {
    const collaborationText = buildCollaborationModeText(turnContext.collaborationMode);
    if (collaborationText) {
      developerSections.push(collaborationText);
    }
  }

  if (
    previousContext &&
    previousContext.personality !== turnContext.personality &&
    personalityMessage
  ) {
    developerSections.push(buildPersonalityText(personalityMessage));
  }

  if (environmentChanged(previousContext, turnContext)) {
    contextualUserSections.push(buildEnvironmentContextText({
      cwd: previousContext?.cwd === turnContext.cwd ? null : turnContext.cwd,
      shell: turnContext.shell,
      currentDate: turnContext.currentDate,
      timezone: turnContext.timezone,
      network:
        JSON.stringify(previousContext?.network ?? null) === JSON.stringify(turnContext.network ?? null)
          ? previousContext?.network ?? null
          : turnContext.network,
    }));
  }

  const items = [];
  const developerMessage = buildDeveloperMessage(developerSections.filter(Boolean));
  if (developerMessage) {
    items.push(developerMessage);
  }
  const contextualUserMessage = buildContextualUserMessage(contextualUserSections.filter(Boolean));
  if (contextualUserMessage) {
    items.push(contextualUserMessage);
  }

  return items;
}
