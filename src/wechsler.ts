import { execFile } from "child_process";

export type WechslerState = "gpu-offline" | "gpu-idle" | "llama-cpp" | "vllm" | "unknown";

export type WechslerStatus = {
  state: WechslerState;
  active_backend: string;
  slots: any[] | null;
  saved_slots: string[];
  gpu_memory: { id: number; used_mib: number; total_mib: number }[] | null;
};

export type WechslerConfig = {
  scriptPath: string;
  managedEndpoints: string[];
};

const DEFAULT_SCRIPT = "/var/lib/clawdbot/workspace/wechsler-llm/wechsler.sh";

/**
 * Run wechsler.sh with arguments, return stdout
 */
function runWechsler(scriptPath: string, args: string[], timeoutMs = 180000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(scriptPath, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Get wechsler status as structured JSON
 */
export async function getWechslerStatus(scriptPath?: string): Promise<WechslerStatus> {
  try {
    const output = await runWechsler(scriptPath ?? DEFAULT_SCRIPT, ["status", "--json"], 15000);
    return JSON.parse(output.trim()) as WechslerStatus;
  } catch (e: any) {
    return {
      state: "unknown",
      active_backend: "none",
      slots: null,
      saved_slots: [],
      gpu_memory: null,
    };
  }
}

/**
 * Switch backend via wechsler. Returns progress lines.
 */
export async function switchBackend(
  target: "llama-cpp" | "vllm",
  scriptPath?: string
): Promise<{ success: boolean; output: string }> {
  try {
    const output = await runWechsler(scriptPath ?? DEFAULT_SCRIPT, ["switch", target]);
    return { success: true, output: output.trim() };
  } catch (e: any) {
    return { success: false, output: e?.message ?? "switch failed" };
  }
}

/**
 * Stop active backend via wechsler
 */
export async function stopBackend(scriptPath?: string): Promise<{ success: boolean; output: string }> {
  try {
    const output = await runWechsler(scriptPath ?? DEFAULT_SCRIPT, ["stop"]);
    return { success: true, output: output.trim() };
  } catch (e: any) {
    return { success: false, output: e?.message ?? "stop failed" };
  }
}

/**
 * Format GPU memory as a compact string
 */
export function formatGpuMemory(gpus: { id: number; used_mib: number; total_mib: number }[] | null): string {
  if (!gpus || gpus.length === 0) return "unknown";
  return gpus.map(g => {
    const pct = Math.round((g.used_mib / g.total_mib) * 100);
    return `GPU${g.id}: ${pct}%`;
  }).join(" | ");
}
