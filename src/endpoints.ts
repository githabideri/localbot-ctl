import * as fs from "fs";

// Types
export type EndpointType = "llama-cpp" | "vllm" | "ollama";

export type ModelMetadata = {
  alias: string;
  name: string;
  context: number;
  vramFit: string;
  speeds: {
    genFresh: number;
    genFilled: number;
    promptFresh: number;
    promptFilled: number;
  };
  notes?: string;
};

export type ModelsRegistry = {
  models: Record<string, ModelMetadata>;
  meta?: {
    lastUpdated?: string;
    updatedBy?: string;
  };
};

export type EndpointConfig = {
  id: string;
  name: string;
  type: EndpointType;
  url: string;
  priority: number;
  notes?: string;
};

export type EndpointsRegistry = {
  endpoints: EndpointConfig[];
  meta?: {
    description?: string;
    lastUpdated?: string;
  };
};

export type ProbeResult = {
  endpoint: EndpointConfig;
  online: boolean;
  model?: string;
  modelPath?: string;
  contextWindow?: number;
  error?: string;
  latencyMs?: number;
  metadata?: ModelMetadata;  // Matched from models registry
};

const DEFAULT_REGISTRY_PATH = "/var/lib/clawdbot/workspace/config/inference-endpoints.json";
const DEFAULT_MODELS_PATH = "/var/lib/clawdbot/workspace/config/localbot-models.json";

/**
 * Load endpoints registry from file
 */
export function loadEndpointsRegistry(path?: string): EndpointsRegistry | null {
  try {
    const content = fs.readFileSync(path ?? DEFAULT_REGISTRY_PATH, "utf-8");
    return JSON.parse(content) as EndpointsRegistry;
  } catch {
    return null;
  }
}

/**
 * Load models registry (performance metadata) from file
 */
export function loadModelsRegistry(path?: string): ModelsRegistry | null {
  try {
    const content = fs.readFileSync(path ?? DEFAULT_MODELS_PATH, "utf-8");
    return JSON.parse(content) as ModelsRegistry;
  } catch {
    return null;
  }
}

/**
 * Find model metadata by matching the probed model name
 * Tries exact match, then partial/fuzzy match on model filename
 */
export function findModelMetadata(modelName: string, registry: ModelsRegistry): ModelMetadata | null {
  // Normalize: remove path, extension, lowercase
  const normalize = (s: string) => s.split("/").pop()?.replace(/\.gguf$/i, "").toLowerCase() ?? s.toLowerCase();
  const normalizedProbe = normalize(modelName);
  
  for (const [key, meta] of Object.entries(registry.models)) {
    const normalizedKey = normalize(key);
    // Exact match
    if (normalizedKey === normalizedProbe) return meta;
    // Partial match (probed name contains key or vice versa)
    if (normalizedProbe.includes(normalizedKey) || normalizedKey.includes(normalizedProbe)) return meta;
  }
  return null;
}

/**
 * Probe a llama-cpp server for status and running model
 */
async function probeLlamaCpp(endpoint: EndpointConfig): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const res = await fetch(`${endpoint.url}/props`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { endpoint, online: false, error: `HTTP ${res.status}`, latencyMs: Date.now() - start };
    }
    const data = await res.json() as any;
    
    // Extract model info from /props
    const modelPath = data.model_path ?? data.model_alias ?? "unknown";
    const modelName = modelPath.split("/").pop()?.replace(/\.gguf$/i, "") ?? modelPath;
    const contextWindow = data.default_generation_settings?.n_ctx ?? data.n_ctx ?? 0;
    
    return {
      endpoint,
      online: true,
      model: modelName,
      modelPath,
      contextWindow,
      latencyMs: Date.now() - start,
    };
  } catch (e: any) {
    return { endpoint, online: false, error: e?.message ?? "connection failed", latencyMs: Date.now() - start };
  }
}

/**
 * Probe a vLLM server for status and running model
 */
async function probeVllm(endpoint: EndpointConfig): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const res = await fetch(`${endpoint.url}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { endpoint, online: false, error: `HTTP ${res.status}`, latencyMs: Date.now() - start };
    }
    const data = await res.json() as any;
    const models = data.data ?? [];
    const firstModel = models[0];
    
    return {
      endpoint,
      online: true,
      model: firstModel?.id ?? "unknown",
      latencyMs: Date.now() - start,
    };
  } catch (e: any) {
    return { endpoint, online: false, error: e?.message ?? "connection failed", latencyMs: Date.now() - start };
  }
}

/**
 * Probe an Ollama server for status and running model
 */
async function probeOllama(endpoint: EndpointConfig): Promise<ProbeResult> {
  const start = Date.now();
  try {
    // First check what models are loaded (running)
    const psRes = await fetch(`${endpoint.url}/api/ps`, {
      signal: AbortSignal.timeout(5000),
    });
    if (psRes.ok) {
      const psData = await psRes.json() as any;
      const runningModels = psData.models ?? [];
      if (runningModels.length > 0) {
        return {
          endpoint,
          online: true,
          model: runningModels[0].name ?? runningModels[0].model ?? "unknown",
          latencyMs: Date.now() - start,
        };
      }
    }
    
    // Fallback: list available models
    const tagsRes = await fetch(`${endpoint.url}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!tagsRes.ok) {
      return { endpoint, online: false, error: `HTTP ${tagsRes.status}`, latencyMs: Date.now() - start };
    }
    const tagsData = await tagsRes.json() as any;
    const models = tagsData.models ?? [];
    
    return {
      endpoint,
      online: true,
      model: models.length > 0 ? `${models.length} available (none loaded)` : "no models",
      latencyMs: Date.now() - start,
    };
  } catch (e: any) {
    return { endpoint, online: false, error: e?.message ?? "connection failed", latencyMs: Date.now() - start };
  }
}

/**
 * Probe an endpoint based on its type
 */
export async function probeEndpoint(endpoint: EndpointConfig): Promise<ProbeResult> {
  switch (endpoint.type) {
    case "llama-cpp":
      return probeLlamaCpp(endpoint);
    case "vllm":
      return probeVllm(endpoint);
    case "ollama":
      return probeOllama(endpoint);
    default:
      return { endpoint, online: false, error: `unknown type: ${endpoint.type}` };
  }
}

/**
 * Probe all endpoints and return sorted by priority
 */
export async function probeAllEndpoints(registry: EndpointsRegistry): Promise<ProbeResult[]> {
  const sorted = [...registry.endpoints].sort((a, b) => a.priority - b.priority);
  const results = await Promise.all(sorted.map(probeEndpoint));
  return results;
}

/**
 * Get the first online endpoint
 */
export async function getActiveEndpoint(registry: EndpointsRegistry): Promise<ProbeResult | null> {
  const results = await probeAllEndpoints(registry);
  return results.find(r => r.online) ?? null;
}
