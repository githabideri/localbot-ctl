import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as fs from "fs";
import {
  loadEndpointsRegistry,
  loadModelsRegistry,
  findModelMetadata,
  probeAllEndpoints,
  getActiveEndpoint,
  type ProbeResult,
  type EndpointsRegistry,
} from "./endpoints.js";
import {
  getWechslerStatus,
  switchBackend,
  stopBackend,
  formatGpuMemory,
  type WechslerConfig,
} from "./wechsler.js";
import {
  loadPowerConfig,
  loadPowerState,
  savePowerState,
  touchActivity,
  startGpuServer,
  shutdownServer,
  formatIdleStatus,
  formatPowerStats,
  checkHealth,
  checkVllmHealth,
  startIdleMonitor,
  setStateFilePath,
  getPowerStats,
  resetSessionBaseline,
  appendSessionEvent,
  getLastStartEvent,
  type PowerConfig,
  type SessionEvent,
} from "./power.js";

type PluginConfig = {
  endpointsPath?: string;
};

// Room config types
type RoomConfig = {
  agentId: string;
  roomName: string;
  publicReset: boolean;
  // Optional static prompt baseline (e.g., /context list "System prompt (run)")
  // used when provider usage counters are unavailable or zeroed.
  basePromptTokens?: number;
};
type RoomsRegistry = {
  rooms: Record<string, RoomConfig>;
  meta?: { description?: string; lastUpdated?: string };
};

// Default config path (can be overridden via plugin config)
const DEFAULT_ROOMS_PATH = "/var/lib/clawdbot/workspace/config/localbot-rooms.json";

// Cached room config
let cachedRooms: Record<string, RoomConfig> = {};
let cachedRoomNameToId: Record<string, string> = {};

function loadRoomsConfig(configPath: string = DEFAULT_ROOMS_PATH): Record<string, RoomConfig> {
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const registry = JSON.parse(content) as RoomsRegistry;
    return registry.rooms ?? {};
  } catch (e) {
    console.warn(`[localbot-ctl] Could not load rooms config from ${configPath}: ${e}`);
    return {};
  }
}

function getRooms(configPath?: string): Record<string, RoomConfig> {
  if (Object.keys(cachedRooms).length === 0) {
    cachedRooms = loadRoomsConfig(configPath);
    // Build reverse lookup
    cachedRoomNameToId = {};
    for (const [roomId, config] of Object.entries(cachedRooms)) {
      cachedRoomNameToId[config.roomName.toLowerCase()] = roomId;
    }
  }
  return cachedRooms;
}

function getRoomNameToId(): Record<string, string> {
  if (Object.keys(cachedRoomNameToId).length === 0) {
    getRooms(); // This populates both caches
  }
  return cachedRoomNameToId;
}

const DEFAULT_ENDPOINTS_PATH = "/var/lib/clawdbot/workspace/config/inference-endpoints.json";
const DEFAULT_GATEWAY_CONFIG_PATH = "/var/lib/clawdbot/.openclaw/openclaw.json";

type AliasEntry = {
  alias: string;
  modelId: string;
  provider: string;
};

type SwitchBackend = "llama-cpp" | "vllm" | "ollama";
type LbmSessionScope = "active" | "all";

type LbmParsedArgs = {
  alias?: string;
  backend?: SwitchBackend;
  endpointId?: string;
  scope: LbmSessionScope;
  setDefault: boolean;
  setOnce: boolean;
  showDefault: boolean;
  errors: string[];
};

type RoutingConfig = {
  backendDefaults?: Partial<Record<SwitchBackend, string>>;
  aliasOverrides?: Record<string, string>;
  defaultUpdateTargets?: string[];
};

type GatewayAgentEntry = {
  id?: string;
  model?: {
    primary?: string;
    fallbacks?: string[];
  };
};

type GatewayConfig = {
  agents?: {
    list?: GatewayAgentEntry[];
    defaults?: {
      models?: Record<string, { alias?: string; params?: Record<string, unknown> }>;
    };
  };
};

const DEFAULT_MODEL_SWITCH_TARGETS = [
  "ht",
  "localbot-fraktalia",
  "localbot-labmaster",
  "localbot-llmlab",
  "localbot-planning",
  "localbot-polis",
  "localbot-schreiber",
];

function loadModelAliases(configPath: string = DEFAULT_GATEWAY_CONFIG_PATH): AliasEntry[] {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      agents?: {
        defaults?: {
          models?: Record<string, { alias?: string }>;
        };
      };
    };

    const modelMap = parsed?.agents?.defaults?.models ?? {};
    const entries: AliasEntry[] = [];

    for (const [modelId, config] of Object.entries(modelMap)) {
      const alias = config?.alias?.trim();
      if (!alias) continue;
      const provider = modelId.split("/")[0] ?? "other";
      entries.push({ alias, modelId, provider });
    }

    return entries.sort((a, b) => a.alias.localeCompare(b.alias));
  } catch (e) {
    console.warn(`[localbot-ctl] Could not load model aliases from ${configPath}: ${e}`);
    return [];
  }
}

function formatAliases(queryRaw?: string): string {
  const all = loadModelAliases();
  if (all.length === 0) {
    return "❌ Could not load model aliases";
  }

  const query = queryRaw?.trim().toLowerCase();
  const filtered = query
    ? all.filter(entry =>
        entry.alias.toLowerCase().includes(query) ||
        entry.modelId.toLowerCase().includes(query) ||
        entry.provider.toLowerCase().includes(query)
      )
    : all;

  if (query && filtered.length === 0) {
    return `❌ No aliases match "${queryRaw?.trim()}"`;
  }

  const grouped = new Map<string, AliasEntry[]>();
  for (const entry of filtered) {
    const list = grouped.get(entry.provider) ?? [];
    list.push(entry);
    grouped.set(entry.provider, list);
  }

  const providerOrder = [
    "openai-codex",
    "openai",
    "anthropic",
    "llama-cpp",
    "llama-local",
    "llama-local-qwen",
    "vllm",
    "ollama",
  ];

  const providers = [...grouped.keys()].sort((a, b) => {
    const ai = providerOrder.indexOf(a);
    const bi = providerOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  const lines: string[] = ["🏷️ Model aliases", "Use: /model <alias>", ""];

  for (const provider of providers) {
    lines.push(`${provider}:`);
    const entries = (grouped.get(provider) ?? []).sort((a, b) => a.alias.localeCompare(b.alias));
    for (const entry of entries) {
      lines.push(`  ${entry.alias} → ${entry.modelId}`);
    }
    lines.push("");
  }

  lines.push(`Total: ${filtered.length}${query ? ` matched (${all.length} available)` : ""}`);
  if (!query) {
    lines.push("Tip: /a openai-codex");
  }

  return lines.join("\n");
}

function parseSwitchBackend(raw?: string): SwitchBackend | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "l" || normalized === "llama" || normalized === "llama-cpp") return "llama-cpp";
  if (normalized === "v" || normalized === "vllm") return "vllm";
  if (normalized === "o" || normalized === "ollama") return "ollama";
  return undefined;
}

function backendShortFlag(backend: SwitchBackend): string {
  if (backend === "llama-cpp") return "-bl";
  if (backend === "vllm") return "-bv";
  return "-bo";
}

function parseLbmSessionScope(raw?: string): LbmSessionScope | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "active") return "active";
  if (normalized === "all") return "all";
  return undefined;
}

function lbmUsage(): string {
  return [
    "Usage:",
    "/lbm",
    "/lbm <alias> [--once] [--default|--set-default] [--scope active|all] [-bl|-bv|-bo|-b l|v|o] [-e <endpoint>]",
    "/lbm --show-default",
    "",
    "Mode flags:",
    "--once (default)  Non-persistent runtime target update for LocalBot+ht sessions.",
    "--default         Persist agent defaults for new sessions (writes openclaw.json).",
    "",
    "Scope flags:",
    "--scope active    Touch only latest mapped Matrix room sessions (default).",
    "--scope all       Touch all session entries for target agents (includes cron/main/subagent).",
  ].join("\n");
}

function parseLbmArgs(raw?: string): LbmParsedArgs {
  const parsed: LbmParsedArgs = {
    scope: "active",
    setDefault: false,
    setOnce: false,
    showDefault: false,
    errors: [],
  };

  const tokens = raw?.trim() ? raw.trim().split(/\s+/) : [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (token === "--set-default" || token === "--default") {
      parsed.setDefault = true;
      continue;
    }

    if (token === "--once") {
      parsed.setOnce = true;
      continue;
    }

    if (token === "--show-default") {
      parsed.showDefault = true;
      continue;
    }

    if (token.startsWith("--scope=")) {
      const value = token.slice("--scope=".length);
      const scope = parseLbmSessionScope(value);
      if (!scope) {
        parsed.errors.push("Invalid scope. Use --scope active|all.");
      } else {
        parsed.scope = scope;
      }
      continue;
    }

    if (token === "--scope") {
      const value = tokens[++i];
      const scope = parseLbmSessionScope(value);
      if (!value || !scope) {
        parsed.errors.push("Invalid scope. Use --scope active|all.");
      } else {
        parsed.scope = scope;
      }
      continue;
    }

    if (token === "-bl") {
      parsed.backend = "llama-cpp";
      continue;
    }

    if (token === "-bv") {
      parsed.backend = "vllm";
      continue;
    }

    if (token === "-bo") {
      parsed.backend = "ollama";
      continue;
    }

    if (token === "-b") {
      const value = tokens[++i];
      const backend = parseSwitchBackend(value);
      if (!value || !backend) {
        parsed.errors.push("Invalid backend flag. Use -b l|v|o (or -bl/-bv/-bo).");
      } else {
        parsed.backend = backend;
      }
      continue;
    }

    if (token === "-e" || token === "--endpoint") {
      const endpointId = tokens[++i];
      if (!endpointId) {
        parsed.errors.push("Missing endpoint id after -e/--endpoint.");
      } else {
        parsed.endpointId = endpointId;
      }
      continue;
    }

    if (token.startsWith("-")) {
      parsed.errors.push(`Unknown flag: ${token}`);
      continue;
    }

    if (!parsed.alias) {
      parsed.alias = token.toLowerCase();
    } else {
      parsed.errors.push(`Unexpected extra argument: ${token}`);
    }
  }

  if (parsed.showDefault && (parsed.alias || parsed.setDefault || parsed.setOnce || parsed.scope !== "active")) {
    parsed.errors.push("--show-default cannot be combined with alias, --default, --once, or --scope.");
  }

  if (parsed.setDefault && parsed.setOnce) {
    parsed.errors.push("Choose one mode: --once or --default.");
  }

  return parsed;
}

function getRoutingConfig(registry: EndpointsRegistry | null): RoutingConfig {
  if (!registry) return {};
  return ((registry as any).modelSwitch?.routing ?? (registry as any).wechsler?.routing ?? {}) as RoutingConfig;
}

function resolveCandidatesByAlias(alias: string, entries: AliasEntry[]): AliasEntry[] {
  const query = alias.toLowerCase();
  return entries.filter(entry => entry.alias.toLowerCase() === query);
}

function backendFromProvider(provider: string): SwitchBackend | undefined {
  if (provider === "llama-cpp") return "llama-cpp";
  if (provider === "vllm") return "vllm";
  if (provider === "ollama") return "ollama";
  return undefined;
}

function backendFromEndpointId(endpointId: string, registry: EndpointsRegistry | null): SwitchBackend | undefined {
  if (!registry) return undefined;
  const endpoint = registry.endpoints.find(e => e.id === endpointId);
  return endpoint ? parseSwitchBackend(endpoint.type) : undefined;
}

function sortCandidates(candidates: AliasEntry[], routing: RoutingConfig): AliasEntry[] {
  return [...candidates].sort((a, b) => {
    const ab = backendFromProvider(a.provider);
    const bb = backendFromProvider(b.provider);
    const aEndpoint = ab ? routing.backendDefaults?.[ab] : undefined;
    const bEndpoint = bb ? routing.backendDefaults?.[bb] : undefined;
    if (aEndpoint && !bEndpoint) return -1;
    if (!aEndpoint && bEndpoint) return 1;
    return a.provider.localeCompare(b.provider);
  });
}

function resolveEndpointId(
  alias: string,
  backend: SwitchBackend,
  endpointIdArg: string | undefined,
  registry: EndpointsRegistry | null,
  routing: RoutingConfig
): { endpointId?: string; error?: string } {
  if (!registry) return { error: "Endpoints registry is unavailable." };

  const endpointIdsByBackend = registry.endpoints
    .filter(e => e.type === backend)
    .map(e => e.id);

  if (endpointIdArg) {
    if (endpointIdsByBackend.includes(endpointIdArg)) {
      return { endpointId: endpointIdArg };
    }
    return {
      error: `Endpoint '${endpointIdArg}' is not a ${backend} endpoint. Available: ${endpointIdsByBackend.join(", ") || "(none)"}`,
    };
  }

  const override = routing.aliasOverrides?.[alias.toLowerCase()];
  if (override) {
    if (endpointIdsByBackend.includes(override)) return { endpointId: override };
    return { error: `Alias override for '${alias}' points to invalid ${backend} endpoint '${override}'.` };
  }

  const backendDefault = routing.backendDefaults?.[backend];
  if (backendDefault) {
    if (endpointIdsByBackend.includes(backendDefault)) return { endpointId: backendDefault };
    return { error: `Backend default for ${backend} points to invalid endpoint '${backendDefault}'.` };
  }

  if (endpointIdsByBackend.length === 1) {
    return { endpointId: endpointIdsByBackend[0] };
  }

  if (endpointIdsByBackend.length > 1) {
    return {
      error: `Multiple ${backend} endpoints available (${endpointIdsByBackend.join(", ")}). Use -e <endpoint>.`,
    };
  }

  return { error: `No ${backend} endpoint configured.` };
}

function listBackendsForAlias(candidates: AliasEntry[]): SwitchBackend[] {
  return [...new Set(candidates
    .map(c => backendFromProvider(c.provider))
    .filter((b): b is SwitchBackend => Boolean(b))
  )];
}

function loadGatewayConfig(path: string = DEFAULT_GATEWAY_CONFIG_PATH): GatewayConfig | null {
  try {
    return JSON.parse(fs.readFileSync(path, "utf-8")) as GatewayConfig;
  } catch (e) {
    console.warn(`[localbot-ctl] Could not load gateway config from ${path}: ${e}`);
    return null;
  }
}

function writeJsonAtomicWithBackup(path: string, data: unknown): { backupPath: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${path}.bak-${stamp}`;
  fs.copyFileSync(path, backupPath);

  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, path);
  return { backupPath };
}

function getDefaultTargetAgents(routing: RoutingConfig): string[] {
  const configured = routing.defaultUpdateTargets?.filter(Boolean) ?? [];
  return configured.length > 0 ? configured : DEFAULT_MODEL_SWITCH_TARGETS;
}

function updatePrimaryModelForAgents(
  modelId: string,
  targetAgents: string[],
  gatewayPath: string = DEFAULT_GATEWAY_CONFIG_PATH
): { changed: Array<{ agentId: string; before?: string; after: string }>; missing: string[]; backupPath?: string; error?: string } {
  const gateway = loadGatewayConfig(gatewayPath);
  if (!gateway?.agents?.list) {
    return { changed: [], missing: targetAgents, error: "Could not load gateway agents list." };
  }

  const changed: Array<{ agentId: string; before?: string; after: string }> = [];
  const missing: string[] = [];

  for (const targetId of targetAgents) {
    const entry = gateway.agents.list.find(agent => agent.id === targetId);
    if (!entry) {
      missing.push(targetId);
      continue;
    }
    const before = entry.model?.primary;
    if (!entry.model) entry.model = {};
    entry.model.primary = modelId;
    changed.push({ agentId: targetId, before, after: modelId });
  }

  let backupPath: string | undefined;
  if (changed.length > 0) {
    backupPath = writeJsonAtomicWithBackup(gatewayPath, gateway).backupPath;
  }

  return { changed, missing, backupPath };
}

function getSessionStorePath(agentId: string): string {
  const openclawPath = `/var/lib/clawdbot/.openclaw/agents/${agentId}/sessions/sessions.json`;
  const legacyPath = `/var/lib/clawdbot/.clawdbot/agents/${agentId}/sessions/sessions.json`;
  try {
    fs.accessSync(openclawPath);
    return openclawPath;
  } catch {
    return legacyPath;
  }
}

function readSessionStore(agentId: string): Record<string, any> {
  try {
    const content = fs.readFileSync(getSessionStorePath(agentId), "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

type SessionTouchAgentSummary = {
  agentId: string;
  touched: number;
  considered: number;
  mappedRooms: number;
  matchedRooms: number;
  missingRooms: number;
  storeMissing: boolean;
};

type SessionTouchSummary = {
  scope: LbmSessionScope;
  touchedSessions: number;
  agents: SessionTouchAgentSummary[];
};

function getMappedRoomIdsByAgent(roomsConfig: Record<string, RoomConfig>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [roomId, config] of Object.entries(roomsConfig)) {
    const existing = map.get(config.agentId) ?? [];
    existing.push(roomId.toLowerCase());
    map.set(config.agentId, existing);
  }
  return map;
}

function listAgentSessionKeys(agentId: string, store: Record<string, unknown>): string[] {
  return Object.keys(store).filter(key => key.startsWith(`agent:${agentId}:`));
}

function findLatestMatrixSessionKeyForRoom(
  agentId: string,
  roomId: string,
  store: Record<string, unknown>
): string | undefined {
  const roomIdLower = roomId.toLowerCase();
  return listAgentSessionKeys(agentId, store)
    .filter(key => key.includes(":matrix:") && key.includes(roomIdLower))
    .sort((a, b) => {
      const aTs = toFiniteNumber((store[a] as SessionEntry | undefined)?.updatedAt) ?? 0;
      const bTs = toFiniteNumber((store[b] as SessionEntry | undefined)?.updatedAt) ?? 0;
      return bTs - aTs;
    })[0];
}

function touchSessionEntriesForTargets(
  modelRuntimeId: string,
  targetAgents: string[],
  scope: LbmSessionScope,
  roomsConfig: Record<string, RoomConfig>
): SessionTouchSummary {
  const now = Date.now();
  const roomIdsByAgent = getMappedRoomIdsByAgent(roomsConfig);
  const result: SessionTouchSummary = {
    scope,
    touchedSessions: 0,
    agents: [],
  };

  for (const agentId of targetAgents) {
    const sessionStorePath = getSessionStorePath(agentId);
    let store: Record<string, unknown>;

    try {
      const raw = fs.readFileSync(sessionStorePath, "utf-8");
      store = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      result.agents.push({
        agentId,
        touched: 0,
        considered: 0,
        mappedRooms: 0,
        matchedRooms: 0,
        missingRooms: 0,
        storeMissing: true,
      });
      continue;
    }

    let keysToTouch: string[] = [];
    let mappedRooms = 0;
    let matchedRooms = 0;
    let missingRooms = 0;

    if (scope === "all") {
      keysToTouch = listAgentSessionKeys(agentId, store);
    } else {
      const mappedRoomIds = roomIdsByAgent.get(agentId) ?? [];
      mappedRooms = mappedRoomIds.length;

      for (const roomId of mappedRoomIds) {
        const key = findLatestMatrixSessionKeyForRoom(agentId, roomId, store);
        if (key) {
          keysToTouch.push(key);
          matchedRooms += 1;
        } else {
          missingRooms += 1;
        }
      }
      keysToTouch = [...new Set(keysToTouch)];
    }

    let touched = 0;
    for (const key of keysToTouch) {
      const entry = store[key];
      if (!entry || typeof entry !== "object") continue;
      (entry as any).model = modelRuntimeId;
      (entry as any).updatedAt = now;
      touched += 1;
    }

    if (touched > 0) {
      fs.writeFileSync(sessionStorePath, JSON.stringify(store, null, 2));
    }

    result.touchedSessions += touched;
    result.agents.push({
      agentId,
      touched,
      considered: keysToTouch.length,
      mappedRooms,
      matchedRooms,
      missingRooms,
      storeMissing: false,
    });
  }

  return result;
}

type SessionEntry = {
  sessionId?: string;
  model?: string;
  contextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  updatedAt?: number;
};

type ContextUsageSource = "transcript" | "totalTokens" | "inputTokens" | "input+output" | "estimate" | "none";

type RoomSessionSnapshot = {
  roomId: string;
  roomName: string;
  agentId: string;
  sessionKey?: string;
  entry?: SessionEntry;
  usedTokens?: number;
  usageSource?: ContextUsageSource;
  basePromptTokens?: number;
  ctxTokens?: number;
  updatedAt?: number;
};

type RuntimeSlot = {
  id?: number;
  n_ctx?: number;
  is_processing?: boolean;
  id_task?: number;
  next_token?: Array<{
    n_decoded?: number;
    n_remain?: number;
  }>;
};

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatTokenCount(tokens?: number): string {
  if (tokens === undefined) return "n/a";
  return Math.round(tokens).toLocaleString("en-US");
}

function formatUsageSource(source?: ContextUsageSource): string {
  if (!source || source === "none") return "unknown";
  return source;
}

function derivePromptTokensFromUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;

  const directPrompt =
    toFiniteNumber(u.input) ??
    toFiniteNumber(u.prompt_tokens) ??
    toFiniteNumber(u.promptTokens) ??
    toFiniteNumber(u.input_tokens) ??
    toFiniteNumber(u.inputTokens);
  if (directPrompt !== undefined) return directPrompt;

  const total =
    toFiniteNumber(u.totalTokens) ??
    toFiniteNumber(u.total) ??
    toFiniteNumber(u.total_tokens);
  const output =
    toFiniteNumber(u.output) ??
    toFiniteNumber(u.output_tokens) ??
    toFiniteNumber(u.outputTokens);
  if (total !== undefined && output !== undefined) {
    return Math.max(0, total - output);
  }

  return undefined;
}

function resolveTranscriptPath(agentId: string, sessionId?: string): string | undefined {
  const normalized = sessionId?.trim();
  if (!normalized) return undefined;

  const openclawPath = `/var/lib/clawdbot/.openclaw/agents/${agentId}/sessions/${normalized}.jsonl`;
  const legacyPath = `/var/lib/clawdbot/.clawdbot/agents/${agentId}/sessions/${normalized}.jsonl`;

  try {
    fs.accessSync(openclawPath);
    return openclawPath;
  } catch {
    try {
      fs.accessSync(legacyPath);
      return legacyPath;
    } catch {
      return undefined;
    }
  }
}

function readLatestPromptTokensFromTranscript(agentId: string, sessionId?: string): number | undefined {
  const transcriptPath = resolveTranscriptPath(agentId, sessionId);
  if (!transcriptPath) return undefined;

  try {
    const content = fs.readFileSync(transcriptPath, "utf-8");
    if (!content.trim()) return undefined;
    const lines = content.trim().split(/\n+/);

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as {
          message?: { usage?: unknown };
          usage?: unknown;
        };
        const usage = parsed?.message?.usage ?? parsed?.usage;
        const promptTokens = derivePromptTokensFromUsage(usage);
        if (promptTokens !== undefined) return promptTokens;
      } catch {
        // Ignore malformed lines and continue scanning backwards.
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function estimatePromptTokensFromTranscript(agentId: string, sessionId?: string): number | undefined {
  const transcriptPath = resolveTranscriptPath(agentId, sessionId);
  if (!transcriptPath) return undefined;

  try {
    const content = fs.readFileSync(transcriptPath, "utf-8");
    if (!content.trim()) return undefined;

    const lines = content.trim().split(/\n+/);
    // Keep this bounded and focused on recent conversational state.
    const recentLines = lines.slice(-240);

    let chars = 0;
    for (const line of recentLines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: Array<{ type?: string; text?: string; thinking?: string }> };
        };
        if (parsed?.type !== "message") continue;
        const role = parsed?.message?.role;
        if (role !== "user" && role !== "assistant") continue;
        const chunks = parsed?.message?.content ?? [];
        for (const chunk of chunks) {
          if (!chunk) continue;
          if (chunk.type === "text" && typeof chunk.text === "string") {
            chars += chunk.text.length;
          } else if (chunk.type === "thinking" && typeof chunk.thinking === "string") {
            chars += chunk.thinking.length;
          }
        }
      } catch {
        // Skip malformed lines.
      }
    }

    if (chars <= 0) return undefined;
    // Rough heuristic used for operator-facing estimate only.
    return Math.round(chars / 4);
  } catch {
    return undefined;
  }
}

function formatAge(timestamp?: number): string {
  if (!timestamp) return "n/a";

  const deltaMs = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(deltaMs / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function compactModelName(model?: string): string {
  if (!model) return "unknown";
  return model.length > 48 ? `${model.slice(0, 47)}…` : model;
}

function findLatestRoomSession(agentId: string, roomId: string, roomConfig?: RoomConfig): Omit<RoomSessionSnapshot, "roomId" | "roomName" | "agentId"> {
  const store = readSessionStore(agentId);
  const roomIdLower = roomId.toLowerCase();

  const matches = Object.entries(store)
    .filter(([key]) => key.startsWith(`agent:${agentId}:`) && key.includes(roomIdLower))
    .sort((a, b) => {
      const aTs = toFiniteNumber((a[1] as SessionEntry)?.updatedAt) ?? 0;
      const bTs = toFiniteNumber((b[1] as SessionEntry)?.updatedAt) ?? 0;
      return bTs - aTs;
    });

  if (matches.length === 0) return { basePromptTokens: toFiniteNumber(roomConfig?.basePromptTokens) };

  const [sessionKey, rawEntry] = matches[0];
  const entry = (rawEntry ?? {}) as SessionEntry;
  const inputTokens = toFiniteNumber(entry.inputTokens);
  const outputTokens = toFiniteNumber(entry.outputTokens);
  const totalTokens = toFiniteNumber(entry.totalTokens);
  const transcriptPromptTokensRaw = readLatestPromptTokensFromTranscript(agentId, entry.sessionId);
  const transcriptPromptTokens =
    transcriptPromptTokensRaw !== undefined && transcriptPromptTokensRaw > 0
      ? transcriptPromptTokensRaw
      : undefined;
  const estimatedTokens = estimatePromptTokensFromTranscript(agentId, entry.sessionId);

  let usedTokens: number | undefined;
  let usageSource: ContextUsageSource = "none";
  if (transcriptPromptTokens !== undefined) {
    usedTokens = transcriptPromptTokens;
    usageSource = "transcript";
  } else if (totalTokens !== undefined && totalTokens > 0) {
    usedTokens = totalTokens;
    usageSource = "totalTokens";
  } else if (inputTokens !== undefined && inputTokens > 0) {
    usedTokens = inputTokens;
    usageSource = "inputTokens";
  } else if ((inputTokens !== undefined && inputTokens > 0) || (outputTokens !== undefined && outputTokens > 0)) {
    usedTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
    usageSource = "input+output";
  } else if (estimatedTokens !== undefined) {
    usedTokens = estimatedTokens;
    usageSource = "estimate";
  }

  return {
    sessionKey,
    entry,
    usedTokens,
    usageSource,
    basePromptTokens: toFiniteNumber(roomConfig?.basePromptTokens),
    ctxTokens: toFiniteNumber(entry.contextTokens),
    updatedAt: toFiniteNumber(entry.updatedAt),
  };
}

function collectRoomSessionSnapshots(roomsConfig: Record<string, RoomConfig>): RoomSessionSnapshot[] {
  const snapshots: RoomSessionSnapshot[] = [];

  for (const [roomId, roomConfig] of Object.entries(roomsConfig)) {
    snapshots.push({
      roomId,
      roomName: roomConfig.roomName,
      agentId: roomConfig.agentId,
      ...findLatestRoomSession(roomConfig.agentId, roomId, roomConfig),
    });
  }

  return snapshots.sort((a, b) => a.roomName.localeCompare(b.roomName));
}

const STALE_ROOM_WINDOW_MS = 24 * 60 * 60 * 1000;

function isStaleRoomSnapshot(snapshot: RoomSessionSnapshot): boolean {
  if (!snapshot.updatedAt) return true;
  return (Date.now() - snapshot.updatedAt) > STALE_ROOM_WINDOW_MS;
}

function getRoomFlags(snapshot: RoomSessionSnapshot): string[] {
  if (!snapshot.sessionKey) return ["no-session"];

  const flags: string[] = [];
  if (isStaleRoomSnapshot(snapshot)) flags.push("stale");

  const used = getEffectiveUsedTokens(snapshot);
  const cap = snapshot.ctxTokens;
  if (cap !== undefined && cap > 0 && used > cap) {
    if (snapshot.usageSource === "transcript") {
      flags.push("ctx>cap");
    } else {
      flags.push("counter-drift");
    }
  }

  return flags;
}

function getEffectiveUsedTokens(snapshot: RoomSessionSnapshot): number {
  const dynamicUsed = snapshot.usedTokens ?? 0;
  const base = snapshot.usageSource === "estimate" ? (snapshot.basePromptTokens ?? 0) : 0;
  const effective = Math.max(0, dynamicUsed + base);
  const cap = snapshot.ctxTokens;
  if (cap !== undefined && cap > 0) return Math.min(effective, cap);
  return effective;
}

function formatUsageBar(used: number, cap: number, width = 12): string {
  if (!Number.isFinite(cap) || cap <= 0) {
    return `[${"░".repeat(width)}]`;
  }

  const ratio = Math.max(0, Math.min(1, used / cap));
  const filled = Math.round(ratio * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function pickFocusRoomSnapshot(roomSnapshots: RoomSessionSnapshot[]): RoomSessionSnapshot | undefined {
  const resolved = roomSnapshots.filter(s => s.sessionKey);
  if (resolved.length === 0) return undefined;

  const active = resolved.filter(s => !isStaleRoomSnapshot(s));
  const pool = active.length > 0 ? active : resolved;

  return [...pool].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
}

function formatRoomSnapshot(snapshot: RoomSessionSnapshot): string {
  if (!snapshot.sessionKey) {
    return `   ◻ ${snapshot.roomName.padEnd(14)} no active session entry`;
  }

  const used = snapshot.usedTokens;
  const cap = snapshot.ctxTokens;
  const flags = getRoomFlags(snapshot).filter(f => f !== "stale");
  const stateIcon = isStaleRoomSnapshot(snapshot) ? "💤" : "✅";
  const sourceSuffix = snapshot.usageSource === "estimate"
    ? ` (base ${formatTokenCount(snapshot.basePromptTokens)} + dyn ${formatTokenCount(snapshot.usedTokens)})`
    : "";

  if (used === undefined || cap === undefined || cap <= 0) {
    const flagText = flags.length > 0 ? ` · ${flags.join(", ")}` : "";
    return `   ${stateIcon} ${snapshot.roomName.padEnd(14)} ${formatTokenCount(getEffectiveUsedTokens(snapshot))} / ${formatTokenCount(cap)} tokens · ${formatAge(snapshot.updatedAt)} · source ${formatUsageSource(snapshot.usageSource)}${sourceSuffix}${flagText}`;
  }

  const effectiveUsed = Math.min(getEffectiveUsedTokens(snapshot), cap);
  const ratio = (effectiveUsed / cap) * 100;
  const flagText = flags.length > 0 ? ` · ${flags.join(", ")}` : "";

  return `   ${stateIcon} ${snapshot.roomName.padEnd(14)} ${formatTokenCount(effectiveUsed)} / ${formatTokenCount(cap)} (${ratio.toFixed(1)}%) · ${formatAge(snapshot.updatedAt)} · source ${formatUsageSource(snapshot.usageSource)}${sourceSuffix}${flagText} · session-tag ${compactModelName(snapshot.entry?.model)}`;
}

function formatSlotLine(slot: RuntimeSlot, fallbackIndex: number): string {
  const slotId = toFiniteNumber(slot.id) ?? fallbackIndex;
  const slotCtx = toFiniteNumber(slot.n_ctx);
  const taskId = toFiniteNumber(slot.id_task);
  const state = slot.is_processing ? "busy" : "idle";

  const nextToken = Array.isArray(slot.next_token) ? slot.next_token[0] : undefined;
  const nDecoded = toFiniteNumber(nextToken?.n_decoded);
  const nRemain = toFiniteNumber(nextToken?.n_remain);
  const totalPlanned = nDecoded !== undefined && nRemain !== undefined ? nDecoded + nRemain : undefined;

  const parts = [
    `#${slotId}`,
    `ctx ${formatTokenCount(slotCtx)}`,
    state,
  ];

  if (taskId !== undefined) parts.push(`task ${taskId}`);
  if (nDecoded !== undefined) {
    parts.push(`gen ${formatTokenCount(nDecoded)}${totalPlanned !== undefined ? `/${formatTokenCount(totalPlanned)}` : ""}`);
  }

  return `   ${parts.join(" · ")}`;
}

function formatHelp(): string {
  const rooms = Object.values(getRooms()).map(r => r.roomName).join(", ");
  return `🤖 LocalBot Control

LocalBot runs on local GPU hardware with switchable inference backends. Use these commands to monitor, switch, and benchmark.

━━━ Commands ━━━

/a [filter]         Aliases — model alias quick list
/aliases [filter]   Same as /a
/lbs [full]         Status — compact by default; use 'full' for detailed slots/rooms
/lbm [alias] ...    Models — list/switch (--once|--default)
/lbe                Endpoints — show all inference backends
/lbw <arg>          Switch/status — llama-cpp | vllm | stop | status
/lbp                Benchmark — test active endpoint speed
/lbn <room>         Reset — clear session context
/lbh                This help

━━━ Power Management ━━━

/lbstart            Wake GPU server (WoL/webhook + boot + warmup)
/lboff              Shutdown GPU server (admin only)
/lbstay [on|off]    Toggle stay-online (skip auto-shutdown)
/lbidle [set <min>] Show idle status / set timeout
/lbpower [reset]    Power consumption stats / reset baseline

━━━ Model Switch Modes ━━━

▸ --once (default) — runtime session-tag update only (non-persistent)
▸ --default        — persist model.primary for LocalBot+ht target agents
▸ /lbm --show-default — inspect persisted defaults
▸ --scope active   — latest mapped Matrix sessions only (default)
▸ --scope all      — includes cron/main/subagent session entries

━━━ Backends ━━━

▸ llama-cpp — GPU, GGUF models, slot persistence, fast startup (~8s)
▸ vLLM — GPU, HF/AWQ models, LMCache, slower startup (~80s)
▸ llama-local — CPU, always-on fallback (~10 tok/s, 196k ctx)

GPU: only one runs at a time. Switching saves state automatically.
CPU: always available independently.
Auto-shutdown after idle period (configurable, default 30min).

━━━ Rooms ━━━
${rooms}

━━━ Speed Notation ━━━
fresh→filled = tok/s with empty context → tok/s near full context`;
}

export function registerLocalBotCommands(api: OpenClawPluginApi) {
  console.log("[localbot-ctl] Registering commands...");
  const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;
  const endpointsPath = pluginConfig.endpointsPath ?? DEFAULT_ENDPOINTS_PATH;

  const aliasesHandler = (ctx: { args?: string }) => {
    return { text: formatAliases(ctx.args) };
  };

  // /a - Quick model alias list
  api.registerCommand({
    name: "a",
    description: "Model alias quick list (optional filter)",
    acceptsArgs: true,
    requireAuth: true,
    handler: aliasesHandler,
  });

  // /aliases - Verbose fallback for /a
  api.registerCommand({
    name: "aliases",
    description: "List model aliases (optional filter)",
    acceptsArgs: true,
    requireAuth: true,
    handler: aliasesHandler,
  });

  // /lbh - Help
  api.registerCommand({
    name: "lbh",
    description: "LocalBot help - show available commands",
    acceptsArgs: false,
    requireAuth: true,
    handler: () => {
      return { text: formatHelp() };
    },
  });

  // /lbs - Status (quick view with wechsler)
  api.registerCommand({
    name: "lbs",
    description: "LocalBot status - backend, GPU, model",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const modeRaw = ctx.args?.trim().toLowerCase();
      const verbose = modeRaw === "full" || modeRaw === "verbose" || modeRaw === "all" || modeRaw === "--full";
      const registry = loadEndpointsRegistry(endpointsPath);
      const wechslerConfig = (registry as any)?.wechsler as WechslerConfig | undefined;
      const wStatus = await getWechslerStatus(wechslerConfig?.scriptPath);
      
      const modelsRegistry = loadModelsRegistry();
      const managedEndpointIds = new Set(
        (wechslerConfig?.managedEndpoints ?? [])
          .map(id => id.trim())
          .filter(id => id.length > 0)
      );
      let activeEndpoint: ProbeResult | null = null;
      if (registry) {
        const probes = await probeAllEndpoints(registry);
        activeEndpoint = probes
          .filter(result => result.online)
          .filter(result => {
            if (managedEndpointIds.size > 0) return managedEndpointIds.has(result.endpoint.id);
            return result.endpoint.type === "llama-cpp" || result.endpoint.type === "vllm";
          })
          .sort((a, b) => a.endpoint.priority - b.endpoint.priority)[0] ?? null;
      }
      const probedBackend = activeEndpoint?.endpoint.type;
      const hasLiveManagedGpuEndpoint = probedBackend === "llama-cpp" || probedBackend === "vllm";
      const sourceOfTruthBackend = wStatus.source_of_truth?.backend;
      const backendLabel = hasLiveManagedGpuEndpoint ? probedBackend : (wStatus.active_backend || "unknown");

      const runtimeCtxCap = toFiniteNumber(activeEndpoint?.contextWindow)
        ?? toFiniteNumber((Array.isArray(wStatus.slots) && wStatus.slots.length > 0)
          ? (wStatus.slots[0] as RuntimeSlot)?.n_ctx
          : undefined);

      const roomSnapshots = collectRoomSessionSnapshots(getRooms());
      const focusSnapshot = pickFocusRoomSnapshot(roomSnapshots);

      const lines: string[] = ["🤖 LocalBot Status", ""];

      // Quick context snapshot first (operator-first)
      if (focusSnapshot) {
        const sessionCap = focusSnapshot.ctxTokens;
        const capCandidate = runtimeCtxCap ?? (sessionCap && sessionCap > 0 ? sessionCap : undefined);

        if (capCandidate && capCandidate > 0) {
          const effectiveCap = (sessionCap && sessionCap > 0)
            ? Math.min(capCandidate, sessionCap)
            : capCandidate;
          const used = Math.min(getEffectiveUsedTokens(focusSnapshot), effectiveCap);
          const ratio = (used / effectiveCap) * 100;
          const age = formatAge(focusSnapshot.updatedAt);

          lines.push(`⚡ Quick ctx (${focusSnapshot.roomName})`);
          lines.push(`   ${formatTokenCount(used)} / ${formatTokenCount(effectiveCap)} (${ratio.toFixed(1)}%) ${formatUsageBar(used, effectiveCap)}`);
          const sourceSuffix = focusSnapshot.usageSource === "estimate"
            ? ` (base ${formatTokenCount(focusSnapshot.basePromptTokens)} + dyn ${formatTokenCount(focusSnapshot.usedTokens)})`
            : "";
          lines.push(`   runtime cap ${runtimeCtxCap ? formatTokenCount(runtimeCtxCap) : "unknown"} · session cap ${sessionCap ? formatTokenCount(sessionCap) : "unknown"} · source ${formatUsageSource(focusSnapshot.usageSource)}${sourceSuffix} · ${age}`);
          lines.push("");
        }
      }

      // GPU server state
      if (wStatus.state === "gpu-offline") {
        if (hasLiveManagedGpuEndpoint) {
          lines.push("🟡 Wechsler reports GPU offline, but managed endpoint is reachable");
          lines.push(`🟢 Backend: ${backendLabel}`);
          lines.push("   /lbw state may be stale; endpoint probe confirms runtime is live");
        } else {
          lines.push("🔴 GPU server offline");
          lines.push("   Use /lbw llama-cpp or /lbw vllm to start");
        }
      } else if (wStatus.state === "gpu-idle") {
        if (hasLiveManagedGpuEndpoint) {
          lines.push("🟡 Wechsler reports GPU idle, but managed endpoint is reachable");
          lines.push(`🟢 Backend: ${backendLabel}`);
          lines.push("   /lbw state may be stale; endpoint probe confirms runtime is live");
        } else {
          lines.push("🟡 GPU server up, no backend running");
          lines.push("   Use /lbw llama-cpp or /lbw vllm to start");
        }
      } else if (wStatus.state === "unknown" && hasLiveManagedGpuEndpoint) {
        lines.push("🟡 Wechsler status unavailable; falling back to endpoint probe");
        lines.push(`🟢 Backend: ${backendLabel}`);
      } else {
        lines.push(`🟢 Backend: ${backendLabel}`);
        
        // GPU memory
        if (wStatus.gpu_memory) {
          lines.push(`🖥️ GPU: ${formatGpuMemory(wStatus.gpu_memory)}`);
        }
      }

      if (sourceOfTruthBackend) {
        lines.push(`🧭 Source-of-truth: ${sourceOfTruthBackend}`);
        if ((backendLabel === "llama-cpp" || backendLabel === "vllm") && sourceOfTruthBackend !== "unknown" && sourceOfTruthBackend !== "none" && sourceOfTruthBackend !== backendLabel) {
          lines.push("⚠️ Source-of-truth differs from live probe; consider /lbw stop then /lbw <backend> to reconcile");
        }
      }

      // Active model info (probe endpoint)
      if (activeEndpoint?.online) {
        lines.push(`📦 Runtime model: ${activeEndpoint.model}`);

        const meta = activeEndpoint.model && modelsRegistry
          ? findModelMetadata(activeEndpoint.model, modelsRegistry)
          : null;

        if (meta && verbose) {
          lines.push(`   ${meta.name} (${meta.alias})`);
          lines.push(`📐 Profile ctx cap: ${formatTokenCount(meta.context)} tokens | ${meta.vramFit} VRAM`);
          lines.push(`⚡ Speed: gen ${meta.speeds.genFresh}→${meta.speeds.genFilled} | pp ${meta.speeds.promptFresh}→${meta.speeds.promptFilled} tok/s`);
        }

        const runtimeCapLine = activeEndpoint.contextWindow
          ? `${formatTokenCount(activeEndpoint.contextWindow)} tokens (~${Math.round(activeEndpoint.contextWindow / 1024)}k)`
          : (meta ? `${formatTokenCount(meta.context)} tokens (profile)` : "unknown");
        lines.push(`📐 Runtime ctx cap: ${runtimeCapLine}`);
      }

      // Runtime slot detail (GPU / llama-cpp)
      if (wStatus.state === "llama-cpp") {
        if (Array.isArray(wStatus.slots) && wStatus.slots.length > 0) {
          const busySlots = wStatus.slots.filter(slot => Boolean((slot as RuntimeSlot | undefined)?.is_processing)).length;
          lines.push(`🧠 GPU slots: ${busySlots}/${wStatus.slots.length} busy`);
          if (verbose) {
            for (const [index, slot] of wStatus.slots.entries()) {
              lines.push(formatSlotLine((slot ?? {}) as RuntimeSlot, index));
            }
          }
        } else {
          lines.push("🧠 GPU slots: unavailable");
        }
      }

      // Saved GPU slots
      if (wStatus.saved_slots.length > 0) {
        lines.push(`💾 Saved: ${wStatus.saved_slots.join(", ")}`);
      }

      // Local CPU server status
      lines.push("");
      if (wStatus.local) {
        if (wStatus.local.state === "local-running") {
          if (Array.isArray(wStatus.local.slots) && wStatus.local.slots.length > 0) {
            const busyLocalSlots = wStatus.local.slots.filter(slot => Boolean((slot as RuntimeSlot | undefined)?.is_processing)).length;
            lines.push(`🟢 Local (CPU): running · ${busyLocalSlots}/${wStatus.local.slots.length} busy`);
            if (verbose) {
              for (const [index, slot] of wStatus.local.slots.entries()) {
                lines.push(formatSlotLine((slot ?? {}) as RuntimeSlot, index));
              }
            }
          } else {
            lines.push("🟢 Local (CPU): running · slots unavailable");
          }

          if (verbose && wStatus.local.saved_slots.length > 0) {
            lines.push(`   💾 Saved: ${wStatus.local.saved_slots.join(", ")}`);
          }
        } else if (wStatus.local.state === "local-offline") {
          lines.push("⚫ Local (CPU): offline");
        } else if (wStatus.local.state === "local-down") {
          lines.push("🟡 Local (CPU): server up, llama-server not running");
        }
      }

      // Room-level current context (OpenClaw session stores)
      const resolvedRoomSnapshots = roomSnapshots.filter(s => s.sessionKey);
      const activeRoomSnapshots = resolvedRoomSnapshots
        .filter(s => !isStaleRoomSnapshot(s))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const staleRoomSnapshots = resolvedRoomSnapshots
        .filter(s => isStaleRoomSnapshot(s))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const missingRoomSnapshots = roomSnapshots
        .filter(s => !s.sessionKey)
        .sort((a, b) => a.roomName.localeCompare(b.roomName));

      const totalUsedTokens = activeRoomSnapshots.reduce((sum, s) => sum + getEffectiveUsedTokens(s), 0);

      lines.push("");
      if (verbose) {
        lines.push("📚 Room ctx (full)");
        lines.push("   used / cap = estimated prompt tokens / session context cap");
        lines.push("   source = transcript | totalTokens | inputTokens | input+output | estimate");
        lines.push("   model shown per room = session-tag (may differ from runtime model)");

        lines.push("   Active (<24h):");
        if (activeRoomSnapshots.length === 0) {
          lines.push("   (none)");
        } else {
          for (const snapshot of activeRoomSnapshots) {
            lines.push(formatRoomSnapshot(snapshot));
          }
        }

        if (staleRoomSnapshots.length > 0) {
          lines.push("   Stale (>=24h):");
          for (const snapshot of staleRoomSnapshots) {
            lines.push(formatRoomSnapshot(snapshot));
          }
        }

        if (missingRoomSnapshots.length > 0) {
          lines.push("   No session entry:");
          for (const snapshot of missingRoomSnapshots) {
            lines.push(formatRoomSnapshot(snapshot));
          }
        }

        lines.push("   Legend: 💤 stale >=24h, counter-drift = non-transcript counter exceeded cap, ctx>cap = transcript-derived usage exceeded cap");
      } else {
        lines.push("📚 Room ctx (compact)");
        lines.push(`   active ${activeRoomSnapshots.length} · stale ${staleRoomSnapshots.length} · missing ${missingRoomSnapshots.length} · in-context ${formatTokenCount(totalUsedTokens)}`);
        if (activeRoomSnapshots.length > 0) {
          const s = activeRoomSnapshots[0];
          const cap = s.ctxTokens && s.ctxTokens > 0 ? s.ctxTokens : runtimeCtxCap;
          if (cap && cap > 0) {
            const used = Math.min(getEffectiveUsedTokens(s), cap);
            const ratio = (used / cap) * 100;
            const estSuffix = s.usageSource === "estimate"
              ? ` · est(base ${formatTokenCount(s.basePromptTokens)} + dyn ${formatTokenCount(s.usedTokens)})`
              : "";
            lines.push(`   latest ${s.roomName}: ${formatTokenCount(used)} / ${formatTokenCount(cap)} (${ratio.toFixed(1)}%) ${formatUsageBar(used, cap)}${estSuffix}`);
          } else {
            lines.push(`   latest ${s.roomName}: ${formatTokenCount(getEffectiveUsedTokens(s))} / unknown`);
          }
        }
        lines.push("   Tip: /lbs full for detailed room/slot dump");
      }

      lines.push("");
      lines.push(`📊 Rooms: ${resolvedRoomSnapshots.length}/${roomSnapshots.length} resolved | active (<24h): ${activeRoomSnapshots.length} | in-context ${formatTokenCount(totalUsedTokens)} tokens`);

      return { text: lines.join("\n") };
    },
  });

  // /lbm - List/switch models
  api.registerCommand({
    name: "lbm",
    description: "LocalBot models - list, switch once, or persist default",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const modelsRegistry = loadModelsRegistry();
      if (!modelsRegistry || !modelsRegistry.models) {
        return { text: `❌ Could not load models registry` };
      }

      const endpointsRegistry = loadEndpointsRegistry(endpointsPath);
      const routing = getRoutingConfig(endpointsRegistry);
      const wechslerConfig = (endpointsRegistry as any)?.wechsler as WechslerConfig | undefined;
      const parsed = parseLbmArgs(ctx.args);

      if (ctx.args?.trim() === "--help") {
        return {
          text: [
            "📦 /lbm usage",
            "",
            ...lbmUsage().split("\n"),
            "",
            "/lbm",
            "  List models with metadata and mark active runtime match.",
            "",
            "Routing resolution order when endpoint is omitted:",
            "  alias override -> backend default -> single endpoint -> error (ambiguous).",
            "",
            "Notes:",
            "  • If alias exists on multiple backends, use -bl/-bv/-bo.",
            "  • /new follows persisted defaults; use --default to change them.",
            "  • Default scope is --scope active (latest mapped Matrix sessions only).",
            "  • Use --scope all only for bulk rewrites (includes cron/subagent entries).",
          ].join("\n"),
        };
      }

      if (parsed.errors.length > 0) {
        return {
          text: `❌ ${parsed.errors[0]}\n\n${lbmUsage()}`,
        };
      }

      // Get active model to mark it in list view
      let activeModel: string | null = null;
      if (endpointsRegistry) {
        const active = await getActiveEndpoint(endpointsRegistry);
        if (active?.online && active.model) {
          activeModel = active.model.toLowerCase();
        }
      }

      if (parsed.showDefault) {
        const gateway = loadGatewayConfig();
        if (!gateway?.agents?.list) {
          return { text: "❌ Could not read gateway config defaults." };
        }

        const targets = getDefaultTargetAgents(routing);
        const lines: string[] = ["🎯 Default model targets", ""];
        for (const id of targets) {
          const agent = gateway.agents.list.find(a => a.id === id);
          if (!agent) {
            lines.push(`❌ ${id}: missing agent`);
            continue;
          }
          lines.push(`• ${id}: ${agent.model?.primary ?? "(unset)"}`);
        }
        return { text: lines.join("\n") };
      }

      if (!parsed.alias) {
        const lines: string[] = ["📦 LocalBot Models", ""];
        
        const entries = Object.entries(modelsRegistry.models).sort((a, b) =>
          a[1].alias.localeCompare(b[1].alias)
        );

        for (const [modelId, meta] of entries) {
          const modelKey = modelId.split("/").pop()?.replace(/\.gguf$/i, "").toLowerCase() ?? "";
          const isActive = activeModel && (
            activeModel.includes(modelKey) || modelKey.includes(activeModel)
          );
          
          const marker = isActive ? " ⬅ active" : "";
          lines.push(`▸ ${meta.alias} — ${meta.name}${marker}`);
          lines.push(`  ${Math.round(meta.context / 1024)}k ctx | gen ${meta.speeds.genFresh}→${meta.speeds.genFilled} | pp ${meta.speeds.promptFresh}→${meta.speeds.promptFilled}`);
          lines.push("");
        }

        if (modelsRegistry.meta?.lastUpdated) {
          lines.push(`Updated: ${modelsRegistry.meta.lastUpdated}`);
        }

        lines.push("Tip: /lbm <alias> --once -bl|-bv|-bo");
        return { text: lines.join("\n") };
      }

      const allAliases = loadModelAliases();
      const candidatesAll = resolveCandidatesByAlias(parsed.alias, allAliases);
      if (candidatesAll.length === 0) {
        return { text: `❌ Unknown alias '${parsed.alias}'. Try /a ${parsed.alias}` };
      }

      const selectionNotes: string[] = [];
      const endpointImpliedBackend = (!parsed.backend && parsed.endpointId)
        ? backendFromEndpointId(parsed.endpointId, endpointsRegistry)
        : undefined;
      let requestedBackend = parsed.backend ?? endpointImpliedBackend;

      if (parsed.endpointId && !requestedBackend) {
        return {
          text: `❌ Endpoint '${parsed.endpointId}' is unknown. Use /lbe to list valid endpoint ids.`,
        };
      }

      if (endpointImpliedBackend && !parsed.backend && parsed.endpointId) {
        selectionNotes.push(`ℹ️ Endpoint '${parsed.endpointId}' implies backend '${endpointImpliedBackend}'.`);
      }

      const candidatesByBackend = requestedBackend
        ? candidatesAll.filter(c => backendFromProvider(c.provider) === requestedBackend)
        : candidatesAll;

      if (candidatesByBackend.length === 0) {
        const availableBackends = listBackendsForAlias(candidatesAll);
        const suggestions = availableBackends.map(b => `/lbm ${parsed.alias} ${backendShortFlag(b)}`).join("   or   ");
        return {
          text: `❌ Alias '${parsed.alias}' is not available on backend '${requestedBackend}'. Available backends: ${availableBackends.join(", ") || "(none)"}${suggestions ? `\nTry: ${suggestions}` : ""}`,
        };
      }

      let selected: AliasEntry | undefined = candidatesByBackend[0];
      if (candidatesByBackend.length > 1 && !requestedBackend) {
        const sorted = sortCandidates(candidatesByBackend, routing);
        const resolved = sorted.map(candidate => {
          const backend = backendFromProvider(candidate.provider);
          if (!backend) return { candidate, backend, error: `provider '${candidate.provider}' is unsupported for /lbm` };
          const endpoint = resolveEndpointId(parsed.alias!, backend, parsed.endpointId, endpointsRegistry, routing);
          return {
            candidate,
            backend,
            endpointId: endpoint.endpointId,
            error: endpoint.error,
          };
        });

        const routable = resolved.filter(item => Boolean(item.backend) && !item.error) as Array<{
          candidate: AliasEntry;
          backend: SwitchBackend;
          endpointId?: string;
          error?: string;
        }>;
        if (routable.length === 1) {
          selected = routable[0].candidate;
          requestedBackend = routable[0].backend;
          selectionNotes.push(
            `ℹ️ Auto-selected backend '${requestedBackend}' because it is the only routable option for alias '${parsed.alias}'.`
          );
        } else {
          const lines = [
            `⚠️ Alias '${parsed.alias}' exists on multiple backends.`,
            "",
            ...resolved.map(item => {
              const backendLabel = item.backend ?? item.candidate.provider;
              if (item.error) {
                return `• ${backendLabel} → ${item.candidate.modelId} (unroutable: ${item.error})`;
              }
              return `• ${backendLabel}${item.endpointId ? ` @ ${item.endpointId}` : ""} → ${item.candidate.modelId}`;
            }),
            "",
            ...listBackendsForAlias(sorted).map(b => `Use: /lbm ${parsed.alias} ${backendShortFlag(b)}${parsed.endpointId ? ` -e ${parsed.endpointId}` : ""}`),
            "Tip: /lbe to inspect available endpoint ids.",
          ];
          return { text: lines.join("\n") };
        }
      }

      if (candidatesByBackend.length > 1 && requestedBackend) {
        const lines = [
          `⚠️ Alias '${parsed.alias}' resolves to multiple models on backend '${requestedBackend}'.`,
          ...candidatesByBackend.map(c => `• ${c.modelId}`),
          "Use a backend-specific alias or clean up duplicate aliases in agents.defaults.models.",
        ];
        return { text: lines.join("\n") };
      }

      if (!selected) {
        return { text: `❌ Could not resolve alias '${parsed.alias}' to a concrete model.` };
      }

      const selectedBackend = backendFromProvider(selected.provider);
      if (!selectedBackend) {
        return { text: `❌ Alias '${parsed.alias}' resolves to unsupported provider '${selected.provider}' for /lbm switching.` };
      }

      const endpointResolution = resolveEndpointId(parsed.alias, selectedBackend, parsed.endpointId, endpointsRegistry, routing);
      if (endpointResolution.error) {
        return {
          text: `❌ ${endpointResolution.error}\nTry: /lbm ${parsed.alias} ${backendShortFlag(selectedBackend)} -e <endpoint>\nTip: /lbe to inspect endpoint ids.`,
        };
      }

      const mode: "default" | "once" = parsed.setDefault ? "default" : "once";
      const modeWasImplicit = mode === "once" && !parsed.setOnce;
      const lines: string[] = [];
      if (selectionNotes.length > 0) {
        lines.push(...selectionNotes);
      }

      const wStatus = await getWechslerStatus(wechslerConfig?.scriptPath);
      if ((selectedBackend === "llama-cpp" || selectedBackend === "vllm") && wStatus.state !== selectedBackend) {
        const switched = await switchBackend(selectedBackend, wechslerConfig?.scriptPath);
        if (!switched.success) {
          return {
            text: `❌ Backend switch failed (${selectedBackend})\n\n${switched.output}`,
          };
        }
        lines.push(`✅ Backend switched to ${selectedBackend}`);
      } else {
        lines.push(`✅ Backend already ${selectedBackend}`);
      }
      lines.push(`🧭 Mode: ${mode === "default" ? "default (persistent)" : "once (non-persistent)"}`);

      const modelRuntimeId = selected.modelId.split("/").slice(1).join("/") || selected.modelId;
      const targets = getDefaultTargetAgents(routing);

      if (parsed.setDefault) {
        const result = updatePrimaryModelForAgents(selected.modelId, targets);
        if (result.error) {
          return { text: `❌ Default update failed: ${result.error}` };
        }

        lines.push(`✅ Default updated: ${selected.alias} → ${selected.modelId}`);
        lines.push(`🎯 Endpoint: ${endpointResolution.endpointId ?? "n/a"}`);
        lines.push(`🧩 Updated agents: ${result.changed.length}`);
        for (const changed of result.changed) {
          lines.push(`   • ${changed.agentId}: ${changed.before ?? "(unset)"} -> ${changed.after}`);
        }
        if (result.missing.length > 0) {
          lines.push(`⚠️ Missing targets: ${result.missing.join(", ")}`);
        }
        if (result.backupPath) {
          lines.push(`💾 Backup: ${result.backupPath}`);
        }
        lines.push("ℹ️ Applies to new sessions only; existing sessions keep current context.");
        lines.push("ℹ️ Matrix/gateway runtime may require /restart before /new reflects persisted defaults.");
      } else {
        lines.push(`✅ Once target selected: ${selected.alias} → ${selected.modelId}`);
        lines.push(`🎯 Endpoint: ${endpointResolution.endpointId ?? "n/a"}`);
        lines.push(
          modeWasImplicit
            ? "ℹ️ Mode defaulted to --once. Use --default to persist for /new sessions."
            : "ℹ️ Non-persistent mode. /new still follows persisted defaults."
        );
      }

      // Apply runtime session model override for target agents to avoid manual agent prompting.
      const roomsConfig = getRooms();
      const touchSummary = touchSessionEntriesForTargets(modelRuntimeId, targets, parsed.scope, roomsConfig);
      lines.push(`🗂️ Runtime session entries touched: ${touchSummary.touchedSessions} (scope: ${touchSummary.scope})`);
      if (parsed.scope === "active") {
        lines.push("ℹ️ Active scope touches only the latest Matrix session per mapped room.");
      } else {
        lines.push("⚠️ Scope all touched all session types (including cron/main/subagent).");
      }
      for (const stat of touchSummary.agents) {
        if (stat.storeMissing) {
          lines.push(`   • ${stat.agentId}: session store missing`);
          continue;
        }
        if (parsed.scope === "active") {
          lines.push(`   • ${stat.agentId}: touched ${stat.touched} (rooms ${stat.matchedRooms}/${stat.mappedRooms}${stat.missingRooms > 0 ? `, missing ${stat.missingRooms}` : ""})`);
        } else {
          lines.push(`   • ${stat.agentId}: touched ${stat.touched}/${stat.considered}`);
        }
      }
      lines.push(`📍 Scope: ${targets.length} target agents (${targets.join(", ")})`);

      return { text: lines.join("\n") };
    },
  });

  // /lbe - Show all endpoints
  api.registerCommand({
    name: "lbe",
    description: "LocalBot endpoints - show all inference backends",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      const registry = loadEndpointsRegistry(endpointsPath);
      if (!registry) {
        return { text: `❌ Could not load endpoints from ${endpointsPath}` };
      }

      const modelsRegistry = loadModelsRegistry();
      const results = await probeAllEndpoints(registry);
      
      const lines: string[] = ["🔌 Inference Endpoints", ""];
      
      for (const result of results) {
        const status = result.online ? "✅" : "❌";
        lines.push(`${status} ${result.endpoint.name} (${result.endpoint.type})`);
        lines.push(`   ${result.endpoint.url}`);
        
        if (result.online && result.model) {
          const meta = modelsRegistry ? findModelMetadata(result.model, modelsRegistry) : null;
          if (meta) {
            lines.push(`   📦 ${meta.name} (${meta.alias})`);
            lines.push(`   ⚡ gen ${meta.speeds.genFresh}→${meta.speeds.genFilled} | pp ${meta.speeds.promptFresh}→${meta.speeds.promptFilled} tok/s`);
          } else {
            lines.push(`   📦 ${result.model}`);
          }
        } else if (!result.online) {
          lines.push(`   ❌ ${result.error}`);
        }
        
        if (result.endpoint.notes) {
          lines.push(`   💡 ${result.endpoint.notes}`);
        }
        lines.push("");
      }
      
      const online = results.filter(r => r.online).length;
      lines.push(`${online}/${results.length} endpoints online`);

      return { text: lines.join("\n") };
    },
  });

  // /lbp - Performance benchmark
  api.registerCommand({
    name: "lbp",
    description: "LocalBot performance - benchmark active endpoint",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      const registry = loadEndpointsRegistry(endpointsPath);
      if (!registry) {
        return { text: `❌ Could not load endpoints` };
      }

      const active = await getActiveEndpoint(registry);
      if (!active || !active.online) {
        return { text: `❌ No active endpoint` };
      }

      const endpoint = active.endpoint;
      const startTime = Date.now();

      if (endpoint.type === "llama-cpp") {
        try {
          const res = await fetch(`${endpoint.url}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "gpt",
              messages: [{ role: "user", content: "Count from 1 to 10" }],
              max_tokens: 30,
            }),
            signal: AbortSignal.timeout(30000),
          });

          if (!res.ok) {
            return { text: `❌ Benchmark failed: HTTP ${res.status}` };
          }

          const data = await res.json() as any;
          const timings = data.timings;
          const elapsed = Date.now() - startTime;

          if (!timings) {
            return { text: `❌ No timing data in response` };
          }

          const lines: string[] = [`⚡ Benchmark: ${endpoint.name}`, ""];
          lines.push(`📦 Model: ${active.model}`);
          lines.push("");
          lines.push(`📝 Generation: ${timings.predicted_per_second?.toFixed(1) ?? "?"} tok/s`);
          lines.push(`📥 Prompt: ${timings.prompt_per_second?.toFixed(1) ?? "?"} tok/s`);
          lines.push(`⏱️ Roundtrip: ${elapsed}ms`);

          return { text: lines.join("\n") };
        } catch (e: any) {
          return { text: `❌ Benchmark failed: ${e?.message ?? "unknown error"}` };
        }
      } else if (endpoint.type === "vllm" || endpoint.type === "ollama") {
        try {
          const apiPath = endpoint.type === "ollama" ? "/api/generate" : "/v1/completions";
          const body = endpoint.type === "ollama" 
            ? { model: active.model, prompt: "Count from 1 to 10", stream: false }
            : { model: active.model, prompt: "Count from 1 to 10", max_tokens: 30 };

          const res = await fetch(`${endpoint.url}${apiPath}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60000),
          });

          const elapsed = Date.now() - startTime;
          
          if (!res.ok) {
            return { text: `❌ Benchmark failed: HTTP ${res.status}` };
          }

          const data = await res.json() as any;
          const lines: string[] = [`⚡ Benchmark: ${endpoint.name}`, ""];
          lines.push(`📦 Model: ${active.model}`);
          lines.push(`⏱️ Roundtrip: ${elapsed}ms`);
          
          if (data.eval_count && data.eval_duration) {
            const tokS = (data.eval_count / (data.eval_duration / 1e9)).toFixed(1);
            lines.push(`📝 Generation: ${tokS} tok/s`);
          }

          return { text: lines.join("\n") };
        } catch (e: any) {
          return { text: `❌ Benchmark failed: ${e?.message ?? "unknown error"}` };
        }
      }

      return { text: `❌ Unknown endpoint type: ${endpoint.type}` };
    },
  });

  // /lbw - Switch backend via wechsler
  api.registerCommand({
    name: "lbw",
    description: "Switch inference backend (llama-cpp|vllm|stop)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const target = ctx.args?.trim().toLowerCase();
      const valid = ["llama-cpp", "vllm", "stop", "status", "current"];

      if (!target || !valid.includes(target)) {
        const wStatus = await getWechslerStatus(
          ((loadEndpointsRegistry(endpointsPath) as any)?.wechsler as WechslerConfig | undefined)?.scriptPath
        );
        return {
          text: `Usage: /lbw <llama-cpp|vllm|stop|status|current>\n\nCurrent: ${wStatus.state}`,
        };
      }

      const wechslerConfig = (loadEndpointsRegistry(endpointsPath) as any)?.wechsler as WechslerConfig | undefined;

      if (target === "status" || target === "current") {
        const status = await getWechslerStatus(wechslerConfig?.scriptPath);
        const source = status.source_of_truth?.backend ?? "unknown";
        const gpu = status.gpu_memory ? formatGpuMemory(status.gpu_memory) : "unknown";
        return {
          text: [
            "🧭 Backend state",
            `wechsler: ${status.state}`,
            `source-of-truth: ${source}`,
            `gpu: ${gpu}`,
          ].join("\n"),
        };
      }

      if (target === "stop") {
        const result = await stopBackend(wechslerConfig?.scriptPath);
        return {
          text: result.success
            ? `✅ Backend stopped\n\n${result.output}`
            : `❌ Stop failed\n\n${result.output}`,
        };
      }

      const result = await switchBackend(
        target as "llama-cpp" | "vllm",
        wechslerConfig?.scriptPath
      );
      
      return {
        text: result.success
          ? `✅ Switched to ${target}\n\n${result.output}`
          : `❌ Switch failed\n\n${result.output}`,
      };
    },
  });

  // /lbn - Reset LocalBot session
  api.registerCommand({
    name: "lbn",
    description: "Reset LocalBot session (current room)",
    acceptsArgs: true,
    requireAuth: false, // We do our own auth check based on room
    handler: async (ctx) => {
      // Room argument is required (plugin commands don't have access to conversation context)
      const roomArg = ctx.args?.trim().toLowerCase();
      
      let conversationId: string | undefined;
      let roomConfig: { agentId: string; roomName: string; publicReset: boolean } | undefined;
      
      const roomNameToId = getRoomNameToId();
      const roomsConfig = getRooms();
      
      if (roomArg && roomNameToId[roomArg]) {
        conversationId = roomNameToId[roomArg];
        roomConfig = roomsConfig[conversationId];
      }

      if (!roomConfig) {
        // List available rooms
        const availableRooms = Object.values(roomsConfig)
          .filter(r => r.publicReset || ctx.isAuthorizedSender)
          .map(r => r.roomName);
        
        const roomList = availableRooms.map(r => `\`${r}\``).join(" ");
        return { text: `Usage: /lbn <room>\n\nRooms: ${roomList}` };
      }

      if (!roomConfig || !conversationId) {
        return { text: `❌ LocalBot not configured for this room` };
      }

      // Auth check: public rooms anyone can reset, private rooms need auth
      if (!roomConfig.publicReset && !ctx.isAuthorizedSender) {
        return { text: `❌ Only authorized users can reset this room` };
      }

      const { agentId, roomName } = roomConfig;
      const sessionStorePath = getSessionStorePath(agentId);

      try {
        let store: Record<string, any> = {};
        try {
          const content = fs.readFileSync(sessionStorePath, "utf-8");
          store = JSON.parse(content);
        } catch {
          // File doesn't exist or is invalid
        }

        // Find the session key for this room
        const sessionKey = Object.keys(store).find(k =>
          k.startsWith(`agent:${agentId}:`) && k.includes(conversationId.toLowerCase())
        );

        if (!sessionKey) {
          return { text: `✅ LocalBot session reset (${roomName}) - was already fresh` };
        }

        const existingEntry = store[sessionKey];
        const oldTokens = existingEntry.totalTokens ?? 0;

        // Reset the session
        const crypto = await import("crypto");
        store[sessionKey] = {
          ...existingEntry,
          sessionId: crypto.randomUUID(),
          updatedAt: Date.now(),
          systemSent: false,
          abortedLastRun: false,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        };

        fs.writeFileSync(sessionStorePath, JSON.stringify(store, null, 2));

        return { text: `✅ LocalBot session reset (${roomName})\n   Cleared ${Math.round(oldTokens / 1000)}k tokens` };
      } catch (e: any) {
        return { text: `❌ Reset failed: ${e?.message ?? "unknown error"}` };
      }
    },
  });

  // ── Power Management Commands ──────────────────────────────────────────

  const powerConfig = loadPowerConfig(endpointsPath);

  // /lbstart - Wake GPU server
  api.registerCommand({
    name: "lbstart",
    description: "Wake GPU server (WoL + boot + warmup)",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      if (!powerConfig) {
        return { text: "❌ Power management not configured. Add a 'power' section to inference-endpoints.json." };
      }

      touchActivity();

      const result = await startGpuServer(powerConfig);
      const lines = [
        result.success ? "⚡ GPU Server Start" : "❌ GPU Server Start Failed",
        "",
        ...result.steps,
      ];

      if (result.cached) {
        lines.push("", "Server was already running — activity timer refreshed.");
      }

      return { text: lines.join("\n") };
    },
  });

  // /lboff - Shutdown GPU server (admin only)
  api.registerCommand({
    name: "lboff",
    description: "Shutdown GPU server (admin only)",
    acceptsArgs: false,
    requireAuth: true,
    handler: async (ctx) => {
      if (!powerConfig) {
        return { text: "❌ Power management not configured." };
      }

      if (!ctx.isAuthorizedSender) {
        return { text: "❌ Only authorized users can shut down the GPU server." };
      }

      // Check if server is even online
      const isOnline = await checkHealth(powerConfig.healthUrl);
      if (!isOnline) {
        return { text: "ℹ️ GPU server appears to be already offline." };
      }

      const result = await shutdownServer(powerConfig.sshHost);
      if (result.success) {
        const state = loadPowerState();

        // Log session end
        if (powerConfig.sessionLogPath && state.lastBootTs) {
          const stats = await getPowerStats(powerConfig).catch(() => null);
          const startEv = getLastStartEvent(powerConfig.sessionLogPath);
          appendSessionEvent(powerConfig.sessionLogPath, {
            event: "end",
            sessionId: startEv?.sessionId ?? new Date().toISOString().split("T")[0],
            timestamp: new Date().toISOString(),
            unixTs: Math.floor(Date.now() / 1000),
            energyKwh: stats?.totalEnergyKwh,
            durationS: Math.round((Date.now() - state.lastBootTs) / 1000),
            energyUsedKwh: startEv?.energyKwh && stats?.totalEnergyKwh
              ? Math.round((stats.totalEnergyKwh - startEv.energyKwh) * 1000) / 1000
              : undefined,
          });
        }

        state.serverOnline = false;
        state.lastShutdownTs = Date.now();
        savePowerState(state);
        return { text: "✅ GPU server shutdown initiated.\n🔌 Server powering off..." };
      } else {
        return { text: `❌ Shutdown failed: ${result.error}` };
      }
    },
  });

  // /lbstay - Toggle stay-online mode
  api.registerCommand({
    name: "lbstay",
    description: "Toggle stay-online (skip auto-shutdown)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      if (!powerConfig) {
        return { text: "❌ Power management not configured." };
      }

      if (!ctx.isAuthorizedSender) {
        return { text: "❌ Only authorized users can toggle stay-online mode." };
      }

      const state = loadPowerState();
      const arg = ctx.args?.trim().toLowerCase();

      if (arg === "on" || arg === "true" || arg === "1") {
        state.stayOnline = true;
      } else if (arg === "off" || arg === "false" || arg === "0") {
        state.stayOnline = false;
        state.lastActivityTs = Date.now(); // Reset idle timer
      } else if (!arg) {
        // Toggle
        state.stayOnline = !state.stayOnline;
        if (!state.stayOnline) {
          state.lastActivityTs = Date.now(); // Reset idle timer on disable
        }
      } else {
        return { text: "Usage: /lbstay [on|off]" };
      }

      savePowerState(state);

      if (state.stayOnline) {
        return { text: "🔒 Stay-online: ON\nGPU server will not auto-shutdown until /lbstay off." };
      } else {
        const timeout = state.idleTimeoutMinutes || powerConfig.idleTimeoutMinutes;
        return { text: `⏱️ Stay-online: OFF\nAuto-shutdown resumes (${timeout}min idle timeout, timer reset).` };
      }
    },
  });

  // /lbidle - Show idle status / set timeout
  api.registerCommand({
    name: "lbidle",
    description: "Show idle status / set auto-shutdown timeout",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      if (!powerConfig) {
        return { text: "❌ Power management not configured." };
      }

      const arg = ctx.args?.trim().toLowerCase();

      // /lbidle set <minutes>
      if (arg?.startsWith("set")) {
        if (!ctx.isAuthorizedSender) {
          return { text: "❌ Only authorized users can change the idle timeout." };
        }

        const parts = arg.split(/\s+/);
        const minutes = parseInt(parts[1], 10);
        if (isNaN(minutes) || minutes < 5 || minutes > 1440) {
          return { text: "Usage: /lbidle set <5-1440>\nMinutes until auto-shutdown." };
        }

        const state = loadPowerState();
        state.idleTimeoutMinutes = minutes;
        savePowerState(state);
        return { text: `✅ Idle timeout set to ${minutes} minutes.` };
      }

      // /lbidle reset — reset activity timer
      if (arg === "reset" || arg === "touch") {
        touchActivity();
        return { text: "✅ Activity timer reset." };
      }

      // Default: show status
      return { text: formatIdleStatus(powerConfig) };
    },
  });

  // /lbpower - Show power stats from Home Assistant
  api.registerCommand({
    name: "lbpower",
    description: "Show power consumption stats",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (ctx) => {
      if (!powerConfig) {
        return { text: "❌ Power management not configured." };
      }

      const arg = ctx.args?.trim().toLowerCase();

      // /lbpower reset — reset session baseline
      if (arg === "reset") {
        if (!ctx.isAuthorizedSender) {
          return { text: "❌ Only authorized users can reset the energy baseline." };
        }
        const ok = await resetSessionBaseline(powerConfig);
        if (ok) {
          return { text: "✅ Session energy baseline reset to current reading." };
        } else {
          return { text: "❌ Failed to reset baseline. Check HA config (haUrl, haTokenFile, haBaselineEntity, haEnergyEntity)." };
        }
      }

      // Default: show stats
      const stats = await getPowerStats(powerConfig);
      if (!stats) {
        return { text: "ℹ️ Power monitoring not configured.\nAdd haUrl, haTokenFile, and haPowerEntity to the power config." };
      }
      return { text: formatPowerStats(stats) };
    },
  });

  // Start idle monitor if power config exists and is enabled
  if (powerConfig?.enabled) {
    startIdleMonitor(powerConfig);
  }
}
