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

function formatHelp(): string {
  const rooms = Object.values(getRooms()).map(r => r.roomName).join(", ");
  return `📖 LocalBot Commands

/lbm           List available models with specs
/lbn <room>    Reset LocalBot session
/lbs           Status (backend, GPU, model)
/lbe           Show all inference endpoints
/lbw <backend> Switch backend (llama-cpp|vllm|stop)
/lbp           Performance benchmark

Rooms: ${rooms}
Speed: fresh→filled (tok/s with empty vs full context)`;
}

export function registerLocalBotCommands(api: OpenClawPluginApi) {
  console.log("[localbot-ctl] Registering commands...");
  const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;
  const endpointsPath = pluginConfig.endpointsPath ?? DEFAULT_ENDPOINTS_PATH;

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
      const lines: string[] = ["🤖 LocalBot Status", ""];

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
      if (registry && (wStatus.state === "llama-cpp" || wStatus.state === "vllm")) {
        const active = await getActiveEndpoint(registry);
        if (active?.online) {
          lines.push(`📦 Model: ${active.model}`);
          
          const meta = active.model && modelsRegistry 
            ? findModelMetadata(active.model, modelsRegistry) 
            : null;
          
          if (meta) {
            lines.push(`   ${meta.name} (${meta.alias})`);
            lines.push(`📐 Context: ${Math.round(meta.context / 1024)}k | ${meta.vramFit} VRAM`);
            lines.push(`⚡ Speed: gen ${meta.speeds.genFresh}→${meta.speeds.genFilled} | pp ${meta.speeds.promptFresh}→${meta.speeds.promptFilled} tok/s`);
          } else if (active.contextWindow) {
            lines.push(`📐 Context: ${Math.round(active.contextWindow / 1024)}k tokens`);
          }
        }
      }

      // Slot info (llama-cpp only)
      if (wStatus.state === "llama-cpp" && wStatus.slots && wStatus.slots.length > 0) {
        const slot = wStatus.slots[0];
        const ctxK = Math.round(slot.n_ctx / 1024);
        lines.push(`🧠 Slot: ${ctxK}k ctx${slot.is_processing ? " (busy)" : " (idle)"}`);
      }

      // Saved slots
      if (wStatus.saved_slots.length > 0) {
        lines.push(`💾 Saved: ${wStatus.saved_slots.join(", ")}`);
      }
      
      // Session stats
      lines.push("");
      let totalTokens = 0;
      let sessionCount = 0;
      for (const { agentId } of Object.values(getRooms())) {
        const store = readSessionStore(agentId);
        for (const [key, entry] of Object.entries(store)) {
          if (key.startsWith(`agent:${agentId}:`)) {
            const tokens = entry.totalTokens ?? ((entry.inputTokens ?? 0) + (entry.outputTokens ?? 0));
            totalTokens += tokens;
            sessionCount++;
          }
        }
      }
      if (sessionCount > 0) {
        lines.push(`📊 Sessions: ${sessionCount} | ${Math.round(totalTokens / 1000)}k tokens`);
      }

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
