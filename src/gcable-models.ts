/** Company gateway catalog, verified against /api/pricing on 2026-11-16.
 * Persist the documented model alias so all callers (including summaries and
 * connection checks) use the same thinking mode without provider-specific JSON.
 */
export const GCABLE_BASE_URL = "https://api.playground.ai.gcable.cc/v1";

export interface GcableModelPreset {
  model: string;
  baseURL: string;
  canDisableThinking: boolean;
  defaultEffort: string;
  efforts: string[];
  variants: Record<string, string>;
  aliases: Record<string, { thinking: boolean; effort: string }>;
}

function preset(model: string, canDisableThinking: boolean, defaultEffort: string, variants: Record<string, string>, extraAliases: Record<string, string> = {}): GcableModelPreset {
  return {
    model, baseURL: GCABLE_BASE_URL, canDisableThinking, defaultEffort,
    efforts: Object.keys(variants), variants,
    aliases: {
      [model]: { thinking: !canDisableThinking, effort: defaultEffort },
      [`${model}-Thinking`]: { thinking: true, effort: defaultEffort },
      ...Object.fromEntries(Object.entries(variants).map(([effort, alias]) => [alias, { thinking: true, effort }])),
      ...Object.fromEntries(Object.entries(extraAliases).map(([alias, effort]) => [alias, { thinking: true, effort }])),
    },
  };
}

export const gcableModelCatalog: readonly GcableModelPreset[] = [
  preset("Gcable-Pro", true, "high", { low: "Gcable-Pro-Low", high: "Gcable-Pro-High", max: "Gcable-Pro-Max" }, { "Gcable-Pro-Thinking-Max": "max" }),
  preset("Gcable-Plus", true, "medium", { low: "Gcable-Plus-Low", medium: "Gcable-Plus-Medium", xhigh: "Gcable-Plus-XHigh" }),
  preset("Gcable-Max", false, "low", { low: "Gcable-Max-Low", high: "Gcable-Max-High", max: "Gcable-Max-Thinking-Max" }),
];

export function describeGcableModel(model: string): { model: string; thinking: boolean; effort: string } | undefined {
  for (const entry of gcableModelCatalog) {
    if (Object.hasOwn(entry.aliases, model)) return { model: entry.model, ...entry.aliases[model] };
  }
  return undefined;
}

export function resolveGcableRequestModel(model: string, effort?: string): string {
  const state = describeGcableModel(model);
  if (!state || !state.thinking || effort === undefined) return model;
  const entry = gcableModelCatalog.find(p => p.model === state.model)!;
  if (!Object.hasOwn(entry.variants, effort)) throw new TypeError(`${entry.model} 不支持 ${effort} 思考强度；可选 ${entry.efforts.join(" / ")}`);
  return entry.variants[effort];
}

export function isGcableEndpoint(baseURL: string): boolean {
  return baseURL.replace(/\/+$/u, "") === GCABLE_BASE_URL;
}
