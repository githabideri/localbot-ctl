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

type PluginConfig = {
  endpointsPath?: string;
};

// Room config types
type RoomConfig = { agentId: string; roomName: string; publicReset: boolean };
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

type SessionEntry = {
  model?: string;
  contextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  updatedAt?: number;
};

type RoomSessionSnapshot = {
  roomId: string;
  roomName: string;
  agentId: string;
  sessionKey?: string;
  entry?: SessionEntry;
  usedTokens?: number;
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

function findLatestRoomSession(agentId: string, roomId: string): Omit<RoomSessionSnapshot, "roomId" | "roomName" | "agentId"> {
  const store = readSessionStore(agentId);
  const roomIdLower = roomId.toLowerCase();

  const matches = Object.entries(store)
    .filter(([key]) => key.startsWith(`agent:${agentId}:`) && key.includes(roomIdLower))
    .sort((a, b) => {
      const aTs = toFiniteNumber((a[1] as SessionEntry)?.updatedAt) ?? 0;
      const bTs = toFiniteNumber((b[1] as SessionEntry)?.updatedAt) ?? 0;
      return bTs - aTs;
    });

  if (matches.length === 0) return {};

  const [sessionKey, rawEntry] = matches[0];
  const entry = (rawEntry ?? {}) as SessionEntry;
  const inputTokens = toFiniteNumber(entry.inputTokens);
  const outputTokens = toFiniteNumber(entry.outputTokens);
  const totalTokens = toFiniteNumber(entry.totalTokens);

  const usedTokens = inputTokens ?? totalTokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0));

  return {
    sessionKey,
    entry,
    usedTokens,
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
      ...findLatestRoomSession(roomConfig.agentId, roomId),
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

  const used = snapshot.usedTokens;
  const cap = snapshot.ctxTokens;
  if (used !== undefined && cap !== undefined && cap > 0 && used > cap) {
    flags.push("store>cap");
  }

  return flags;
}

function getEffectiveUsedTokens(snapshot: RoomSessionSnapshot): number {
  const used = snapshot.usedTokens;
  const cap = snapshot.ctxTokens;
  if (used === undefined) return 0;
  if (cap !== undefined && cap > 0) return Math.min(used, cap);
  return used;
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

  if (used === undefined || cap === undefined || cap <= 0) {
    const flagText = flags.length > 0 ? ` · ${flags.join(", ")}` : "";
    return `   ${stateIcon} ${snapshot.roomName.padEnd(14)} ${formatTokenCount(used)} / ${formatTokenCount(cap)} tokens · ${formatAge(snapshot.updatedAt)}${flagText}`;
  }

  const effectiveUsed = Math.min(used, cap);
  const ratio = (effectiveUsed / cap) * 100;
  const flagText = flags.length > 0 ? ` · ${flags.join(", ")}` : "";

  return `   ${stateIcon} ${snapshot.roomName.padEnd(14)} ${formatTokenCount(effectiveUsed)} / ${formatTokenCount(cap)} (${ratio.toFixed(1)}%) · ${formatAge(snapshot.updatedAt)}${flagText} · session-tag ${compactModelName(snapshot.entry?.model)}`;
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
/lbs                Status — backend, GPU, model, slots
/lbm                Models — list available models with specs
/lbe                Endpoints — show all inference backends
/lbw <backend>      Switch — llama-cpp | vllm | stop
/lbp                Benchmark — test active endpoint speed
/lbn <room>         Reset — clear session context
/lbh                This help

━━━ Backends ━━━

▸ llama-cpp — GPU, GGUF models, slot persistence, fast startup (~8s)
▸ vLLM — GPU, HF/AWQ models, LMCache, slower startup (~80s)
▸ llama-local — CPU, always-on fallback (~10 tok/s, 196k ctx)

GPU: only one runs at a time. Switching saves state automatically.
CPU: always available independently.

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
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      const registry = loadEndpointsRegistry(endpointsPath);
      const wechslerConfig = (registry as any)?.wechsler as WechslerConfig | undefined;
      const wStatus = await getWechslerStatus(wechslerConfig?.scriptPath);
      
      const modelsRegistry = loadModelsRegistry();
      const activeEndpoint: ProbeResult | null = (registry && (wStatus.state === "llama-cpp" || wStatus.state === "vllm"))
        ? await getActiveEndpoint(registry)
        : null;

      const runtimeCtxCap = toFiniteNumber(activeEndpoint?.contextWindow)
        ?? toFiniteNumber((Array.isArray(wStatus.slots) && wStatus.slots.length > 0)
          ? (wStatus.slots[0] as RuntimeSlot)?.n_ctx
          : undefined);

      const roomSnapshots = collectRoomSessionSnapshots(getRooms());
      const focusSnapshot = pickFocusRoomSnapshot(roomSnapshots);

      const lines: string[] = ["🤖 LocalBot Status", ""];

      // Quick context snapshot first (operator-first)
      if (focusSnapshot && runtimeCtxCap && runtimeCtxCap > 0) {
        const sessionCap = focusSnapshot.ctxTokens;
        const effectiveCap = (sessionCap && sessionCap > 0)
          ? Math.min(runtimeCtxCap, sessionCap)
          : runtimeCtxCap;
        const used = Math.min(focusSnapshot.usedTokens ?? 0, effectiveCap);
        const ratio = (used / effectiveCap) * 100;
        const age = formatAge(focusSnapshot.updatedAt);

        lines.push(`⚡ Quick ctx (${focusSnapshot.roomName})`);
        lines.push(`   ${formatTokenCount(used)} / ${formatTokenCount(effectiveCap)} (${ratio.toFixed(1)}%) ${formatUsageBar(used, effectiveCap)}`);
        lines.push(`   runtime cap ${formatTokenCount(runtimeCtxCap)} · session cap ${formatTokenCount(sessionCap)} · ${age}`);
        lines.push("");
      }

      // GPU server state
      if (wStatus.state === "gpu-offline") {
        lines.push("🔴 GPU server offline");
        lines.push("   Use /lbw llama-cpp or /lbw vllm to start");
      } else if (wStatus.state === "gpu-idle") {
        lines.push("🟡 GPU server up, no backend running");
        lines.push("   Use /lbw llama-cpp or /lbw vllm to start");
      } else {
        lines.push(`🟢 Backend: ${wStatus.active_backend}`);
        
        // GPU memory
        if (wStatus.gpu_memory) {
          lines.push(`🖥️ GPU: ${formatGpuMemory(wStatus.gpu_memory)}`);
        }
      }

      // Active model info (probe endpoint)
      if (activeEndpoint?.online) {
        lines.push(`📦 Runtime model: ${activeEndpoint.model}`);

        const meta = activeEndpoint.model && modelsRegistry
          ? findModelMetadata(activeEndpoint.model, modelsRegistry)
          : null;

        if (meta) {
          lines.push(`   ${meta.name} (${meta.alias})`);
          lines.push(`📐 Profile ctx cap: ${formatTokenCount(meta.context)} tokens | ${meta.vramFit} VRAM`);
          lines.push(`⚡ Speed: gen ${meta.speeds.genFresh}→${meta.speeds.genFilled} | pp ${meta.speeds.promptFresh}→${meta.speeds.promptFilled} tok/s`);
        }

        if (activeEndpoint.contextWindow) {
          lines.push(`📐 Runtime ctx cap: ${formatTokenCount(activeEndpoint.contextWindow)} tokens (~${Math.round(activeEndpoint.contextWindow / 1024)}k)`);
        }
      }

      // Runtime slot detail (GPU / llama-cpp)
      if (wStatus.state === "llama-cpp") {
        if (Array.isArray(wStatus.slots) && wStatus.slots.length > 0) {
          lines.push(`🧠 GPU slots (${wStatus.slots.length})`);
          for (const [index, slot] of wStatus.slots.entries()) {
            lines.push(formatSlotLine((slot ?? {}) as RuntimeSlot, index));
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
          lines.push("🟢 Local (CPU): running");

          if (Array.isArray(wStatus.local.slots) && wStatus.local.slots.length > 0) {
            lines.push(`   Slots: ${wStatus.local.slots.length}`);
            for (const [index, slot] of wStatus.local.slots.entries()) {
              lines.push(formatSlotLine((slot ?? {}) as RuntimeSlot, index));
            }
          } else {
            lines.push("   Slots: unavailable");
          }

          if (wStatus.local.saved_slots.length > 0) {
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

      lines.push("");
      lines.push("📚 Room ctx (details)");
      lines.push("   used / cap = session prompt tokens / session context cap");
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

      lines.push("   Legend: 💤 stale >=24h, store>cap = historical counter exceeded cap");

      const totalUsedTokens = activeRoomSnapshots.reduce((sum, s) => sum + getEffectiveUsedTokens(s), 0);

      lines.push("");
      lines.push(`📊 Rooms: ${resolvedRoomSnapshots.length}/${roomSnapshots.length} resolved | active (<24h): ${activeRoomSnapshots.length} | in-context ${formatTokenCount(totalUsedTokens)} tokens`);

      return { text: lines.join("\n") };
    },
  });

  // /lbm - List models
  api.registerCommand({
    name: "lbm",
    description: "LocalBot models - list available models with specs",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      const modelsRegistry = loadModelsRegistry();
      if (!modelsRegistry || !modelsRegistry.models) {
        return { text: `❌ Could not load models registry` };
      }

      // Get active model to mark it
      const endpointsRegistry = loadEndpointsRegistry(endpointsPath);
      let activeModel: string | null = null;
      if (endpointsRegistry) {
        const active = await getActiveEndpoint(endpointsRegistry);
        if (active?.online && active.model) {
          activeModel = active.model.toLowerCase();
        }
      }

      const lines: string[] = ["📦 LocalBot Models", ""];
      
      // Sort by alias
      const entries = Object.entries(modelsRegistry.models).sort((a, b) => 
        a[1].alias.localeCompare(b[1].alias)
      );

      for (const [modelId, meta] of entries) {
        // Check if this is the active model
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
      
      if (!target || !["llama-cpp", "vllm", "stop"].includes(target)) {
        const wStatus = await getWechslerStatus(
          ((loadEndpointsRegistry(endpointsPath) as any)?.wechsler as WechslerConfig | undefined)?.scriptPath
        );
        return {
          text: `Usage: /lbw <llama-cpp|vllm|stop>\n\nCurrent: ${wStatus.state}`,
        };
      }

      const wechslerConfig = (loadEndpointsRegistry(endpointsPath) as any)?.wechsler as WechslerConfig | undefined;

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
}
