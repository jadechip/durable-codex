import { MODEL_CATALOG } from "./model-catalog.generated.js";

const PERSONALITY_PLACEHOLDER = "{{ personality }}";

function resolvePersonalityMessage(modelMessages, personality) {
  const variables = modelMessages?.instructions_variables;
  if (!variables || typeof variables !== "object") {
    return "";
  }

  switch (personality) {
    case "friendly":
      return variables.personality_friendly || variables.personality_default || "";
    case "pragmatic":
      return variables.personality_pragmatic || variables.personality_default || "";
    case "none":
      return "";
    default:
      return variables.personality_default || "";
  }
}

export function getModelCatalogEntry(model) {
  if (typeof model !== "string" || !model) {
    return null;
  }

  return MODEL_CATALOG[model] ?? null;
}

export function resolveModelBaseInstructions(model, personality = null) {
  const entry = getModelCatalogEntry(model);
  if (!entry) {
    return null;
  }

  const template = entry.modelMessages?.instructions_template;
  if (typeof template === "string" && template) {
    return template.replace(
      PERSONALITY_PLACEHOLDER,
      resolvePersonalityMessage(entry.modelMessages, personality),
    );
  }

  return entry.baseInstructions;
}
