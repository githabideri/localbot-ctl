import { execFile } from "child_process";
import * as dgram from "dgram";
import * as fs from "fs";

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Wake method configuration.
 * - "wol": Send Wake-on-LAN magic packet (requires macAddress)
 * - "webhook": Call an HTTP webhook (e.g. Home Assistant) to power on
 * - "both": Send WoL AND call webhook (belt + suspenders)
 */
export type WakeMethod = "wol" | "webhook" | "both";

export type PowerConfig = {
  /** How to wake the server */
  wakeMethod: WakeMethod;
  /** MAC address for WoL (required if wakeMethod includes wol) */
  macAddress?: string;
  /** Webhook URL to call for power-on (required if wakeMethod includes webhook) */
  webhookUrl?: string;
  /** SSH host alias or IP for server management */
  sshHost: string;
  /** Health check URL (e.g. vLLM /v1/models or llama.cpp /health) */
  healthUrl: string;
  /** Minutes of inactivity before auto-shutdown */
  idleTimeoutMinutes: number;
  /** How often to check idle state (minutes) */
  checkIntervalMinutes: number;
  /** Model name for warmup request */
  warmupModel?: string;
  /** Enable power management */
  enabled: boolean;

  // ── Optional: Session logging (JSONL) ──
  /** Path to JSONL file for session event logging */
  sessionLogPath?: string;

  // ── Optional: Home Assistant REST API for power monitoring ──
  /** HA base URL (e.g. http://100.x.x.x:8123) */
  haUrl?: string;
  /** Path to file containing HA long-lived access token */
  haTokenFile?: string;
  /** HA entity ID for current power (watts) */
  haPowerEntity?: string;
  /** HA entity ID for cumulative energy (kWh) */
  haEnergyEntity?: string;
  /** HA entity ID for session baseline energy */
  haBaselineEntity?: string;
  /** HA entity ID for socket switch */
  haSocketEntity?: string;
};

export type PowerState = {
  stayOnline: boolean;
  lastActivityTs: number;
  lastWolTs: number | null;
  lastShutdownTs: number | null;
  lastBootTs: number | null;
  serverOnline: boolean;
  bootInProgress: boolean;
  idleTimeoutMinutes: number;
};

export type PowerStats = {
  currentPowerW: number;
  totalEnergyKwh: number;
  sessionBaselineKwh: number;
  sessionEnergyKwh: number;
  socketState: string;
  timestamp: string;
};

// ── Session event logging (JSONL) ──────────────────────────────────────

export type SessionEvent = {
  event: "start" | "end";
  sessionId: string;
  timestamp: string;
  unixTs: number;
  energyKwh?: number;
  powerW?: number;
  durationS?: number;
  energyUsedKwh?: number;
  bootTimeS?: number;
};

function generateSessionId(): string {
  const now = new Date();
  const d = now.toISOString().split("T")[0];
  const t = now.toTimeString().split(" ")[0].replace(/:/g, "");
  return `${d}-${t}`;
}

export function appendSessionEvent(logPath: string, event: SessionEvent): void {
  try {
    const dir = logPath.substring(0, logPath.lastIndexOf("/"));
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(event) + "\n");
  } catch (e) {
    console.error("[power] Failed to write session event:", e);
  }
}

export function getLastStartEvent(logPath: string): { sessionId: string; energyKwh?: number } | null {
  try {
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(l => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      const ev = JSON.parse(lines[i]) as SessionEvent;
      if (ev.event === "start") return { sessionId: ev.sessionId, energyKwh: ev.energyKwh };
    }
  } catch { /* ignore */ }
  return null;
}

// State file path — loaded from config, falls back to cwd-relative
let stateFilePath = "power-state.json";

export function setStateFilePath(path: string): void {
  stateFilePath = path;
}

// ── State persistence ──────────────────────────────────────────────────

export function loadPowerState(): PowerState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFilePath, "utf-8"));
    return {
      stayOnline: Boolean(raw.stayOnline),
      lastActivityTs: Number(raw.lastActivityTs) || Date.now(),
      lastWolTs: raw.lastWolTs ? Number(raw.lastWolTs) : null,
      lastShutdownTs: raw.lastShutdownTs ? Number(raw.lastShutdownTs) : null,
      lastBootTs: raw.lastBootTs ? Number(raw.lastBootTs) : null,
      serverOnline: Boolean(raw.serverOnline),
      bootInProgress: Boolean(raw.bootInProgress),
      idleTimeoutMinutes: Number(raw.idleTimeoutMinutes) || 30,
    };
  } catch {
    return defaultPowerState();
  }
}

function defaultPowerState(): PowerState {
  return {
    stayOnline: false,
    lastActivityTs: Date.now(),
    lastWolTs: null,
    lastShutdownTs: null,
    lastBootTs: null,
    serverOnline: false,
    bootInProgress: false,
    idleTimeoutMinutes: 30,
  };
}

export function savePowerState(state: PowerState): void {
  const dir = stateFilePath.substring(0, stateFilePath.lastIndexOf("/"));
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
}

export function touchActivity(): void {
  const state = loadPowerState();
  state.lastActivityTs = Date.now();
  savePowerState(state);
}

// ── Wake-on-LAN ────────────────────────────────────────────────────────

export function sendWakeOnLan(mac: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const macBytes = Buffer.from(mac.replace(/:/g, ""), "hex");
    if (macBytes.length !== 6) {
      reject(new Error(`Invalid MAC address: ${mac}`));
      return;
    }
    const magic = Buffer.alloc(102);
    magic.fill(0xff, 0, 6);
    for (let i = 0; i < 16; i++) {
      macBytes.copy(magic, 6 + i * 6);
    }

    const socket = dgram.createSocket("udp4");
    socket.once("error", (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(magic, 0, magic.length, 9, "255.255.255.255", (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

// ── Webhook wake ───────────────────────────────────────────────────────

export async function sendWakeWebhook(url: string): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`Webhook returned HTTP ${res.status}`);
  }
}

// ── Combined wake ──────────────────────────────────────────────────────

export async function wakeServer(config: PowerConfig): Promise<string[]> {
  const steps: string[] = [];
  const method = config.wakeMethod;

  if ((method === "wol" || method === "both") && config.macAddress) {
    try {
      await sendWakeOnLan(config.macAddress);
      steps.push("✅ WoL packet sent");
    } catch (e: any) {
      steps.push(`❌ WoL failed: ${e.message}`);
      if (method === "wol") throw e; // Fatal only if WoL is the sole method
    }
  }

  if ((method === "webhook" || method === "both") && config.webhookUrl) {
    try {
      await sendWakeWebhook(config.webhookUrl);
      steps.push("✅ Power webhook triggered");
    } catch (e: any) {
      steps.push(`❌ Webhook failed: ${e.message}`);
      if (method === "webhook") throw e;
    }
  }

  return steps;
}

// ── SSH helpers ─────────────────────────────────────────────────────────

function sshCommand(host: string, command: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ssh",
      ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", host, command],
      { timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message));
        else resolve(stdout.trim());
      }
    );
  });
}

// ── Health checks ───────────────────────────────────────────────────────

export async function checkHealth(url: string): Promise<boolean> {
  try {
    // Try vLLM-style first (/v1/models), fall back to llama.cpp (/health)
    const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return true;
    // Try /health for llama.cpp
    const res2 = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    return res2.ok;
  } catch {
    return false;
  }
}

// Keep old name as alias for backward compat
export const checkVllmHealth = checkHealth;

export async function checkSshReachable(host: string): Promise<boolean> {
  try {
    await sshCommand(host, "echo ok", 10000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check vLLM metrics for active requests. Returns number of running requests,
 * or null if metrics are unavailable.
 */
export async function getRunningRequestCount(url: string): Promise<number | null> {
  try {
    const res = await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const text = await res.text();
    // Parse Prometheus gauge: vllm:num_requests_running{...} <value>
    const match = text.match(/^vllm:num_requests_running\{[^}]*\}\s+(\d+(?:\.\d+)?)/m);
    if (match) return parseFloat(match[1]);
    return null;
  } catch {
    return null;
  }
}

export async function waitForReady(
  url: string,
  sshHost: string,
  timeoutMs = 300000,
  intervalMs = 5000,
  onProgress?: (msg: string) => void
): Promise<{ ready: boolean; sshReadyMs?: number; serverReadyMs?: number }> {
  const start = Date.now();
  let sshReadyMs: number | undefined;
  let serverReadyMs: number | undefined;

  // Phase 1: Wait for SSH
  while (Date.now() - start < Math.min(timeoutMs, 120000)) {
    if (await checkSshReachable(sshHost)) {
      sshReadyMs = Date.now() - start;
      onProgress?.(`SSH reachable (${Math.round(sshReadyMs / 1000)}s)`);
      break;
    }
    touchActivity();
    await sleep(intervalMs);
  }

  if (sshReadyMs === undefined) {
    return { ready: false };
  }

  // Phase 2: Wait for inference server
  while (Date.now() - start < timeoutMs) {
    if (await checkHealth(url)) {
      serverReadyMs = Date.now() - start;
      onProgress?.(`Inference server ready (${Math.round(serverReadyMs / 1000)}s)`);
      return { ready: true, sshReadyMs, serverReadyMs };
    }
    touchActivity();
    await sleep(intervalMs);
  }

  return { ready: false, sshReadyMs };
}

// ── Warmup ──────────────────────────────────────────────────────────────

export async function sendWarmupRequest(
  url: string,
  model?: string
): Promise<{ success: boolean; timeMs: number }> {
  const start = Date.now();
  try {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-openclaw",
      },
      body: JSON.stringify({
        model: model ?? "default",
        messages: [{ role: "user", content: "Say OK." }],
        max_tokens: 2,
      }),
      signal: AbortSignal.timeout(180000),
    });
    return { success: res.ok, timeMs: Date.now() - start };
  } catch {
    return { success: false, timeMs: Date.now() - start };
  }
}

// ── Power monitoring (Home Assistant REST API) ──────────────────────────

function loadHaToken(tokenFile: string): string | null {
  try {
    return fs.readFileSync(tokenFile, "utf-8").trim();
  } catch {
    return null;
  }
}

async function haGetState(haUrl: string, token: string, entityId: string): Promise<string | null> {
  try {
    const res = await fetch(`${haUrl}/api/states/${entityId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.state ?? null;
  } catch {
    return null;
  }
}

export async function getPowerStats(config: PowerConfig): Promise<PowerStats | null> {
  if (!config.haUrl || !config.haTokenFile) return null;

  const token = loadHaToken(config.haTokenFile);
  if (!token) return null;

  const [power, energy, baseline, socket] = await Promise.all([
    config.haPowerEntity ? haGetState(config.haUrl, token, config.haPowerEntity) : null,
    config.haEnergyEntity ? haGetState(config.haUrl, token, config.haEnergyEntity) : null,
    config.haBaselineEntity ? haGetState(config.haUrl, token, config.haBaselineEntity) : null,
    config.haSocketEntity ? haGetState(config.haUrl, token, config.haSocketEntity) : null,
  ]);

  const totalEnergy = parseFloat(energy ?? "0") || 0;
  const baselineVal = parseFloat(baseline ?? "0") || 0;

  return {
    currentPowerW: parseFloat(power ?? "0") || 0,
    totalEnergyKwh: totalEnergy,
    sessionBaselineKwh: baselineVal,
    sessionEnergyKwh: Math.round((totalEnergy - baselineVal) * 1000) / 1000,
    socketState: socket ?? "unknown",
    timestamp: new Date().toISOString(),
  };
}

export async function resetSessionBaseline(config: PowerConfig): Promise<boolean> {
  if (!config.haUrl || !config.haTokenFile || !config.haBaselineEntity || !config.haEnergyEntity) {
    return false;
  }

  const token = loadHaToken(config.haTokenFile);
  if (!token) return false;

  // Read current energy
  const energy = await haGetState(config.haUrl, token, config.haEnergyEntity);
  if (!energy) return false;

  // Set baseline to current energy
  try {
    const res = await fetch(`${config.haUrl}/api/services/input_number/set_value`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entity_id: config.haBaselineEntity,
        value: parseFloat(energy),
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Server lifecycle ────────────────────────────────────────────────────

export async function shutdownServer(
  sshHost: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await sshCommand(sshHost, "shutdown -h now", 15000);
    return { success: true };
  } catch (e: any) {
    const msg = e?.message ?? "";
    // SSH often disconnects mid-shutdown — that's success
    if (
      msg.includes("closed") ||
      msg.includes("Connection") ||
      msg.includes("reset") ||
      msg.includes("Broken pipe")
    ) {
      return { success: true };
    }
    return { success: false, error: msg };
  }
}

export type StartResult = {
  success: boolean;
  steps: string[];
  totalMs: number;
  cached: boolean;
};

export async function startGpuServer(config: PowerConfig): Promise<StartResult> {
  const steps: string[] = [];
  const start = Date.now();
  const state = loadPowerState();

  // Already online?
  if (await checkHealth(config.healthUrl)) {
    steps.push("✅ Server already online — skipping boot");
    state.serverOnline = true;
    state.lastActivityTs = Date.now();
    state.bootInProgress = false;
    savePowerState(state);
    return { success: true, steps, totalMs: Date.now() - start, cached: true };
  }

  // Wake cooldown: don't send if one was sent <60s ago
  const wolCooldownMs = 60_000;
  if (state.lastWolTs && Date.now() - state.lastWolTs < wolCooldownMs) {
    steps.push("⏳ Wake signal recently sent, skipping duplicate");
  } else {
    try {
      const wakeSteps = await wakeServer(config);
      steps.push(...wakeSteps);
      state.lastWolTs = Date.now();
    } catch (e: any) {
      steps.push(`❌ Wake failed: ${e.message}`);
      return { success: false, steps, totalMs: Date.now() - start, cached: false };
    }
  }

  state.bootInProgress = true;
  savePowerState(state);

  // Wait for SSH + inference server
  steps.push("⏳ Waiting for server boot...");
  const result = await waitForReady(
    config.healthUrl,
    config.sshHost,
    600000,
    5000,
    (msg) => steps.push(`  ✅ ${msg}`)
  );

  if (!result.ready) {
    steps.push("❌ Server did not become ready within timeout");
    state.bootInProgress = false;
    savePowerState(state);
    return { success: false, steps, totalMs: Date.now() - start, cached: false };
  }

  // Warmup
  if (config.warmupModel) {
    steps.push("⏳ Sending warmup request...");
    const warmup = await sendWarmupRequest(config.healthUrl, config.warmupModel);
    if (warmup.success) {
      steps.push(`✅ Warmup complete (${Math.round(warmup.timeMs / 1000)}s)`);
    } else {
      steps.push(`⚠️ Warmup failed (non-critical, ${Math.round(warmup.timeMs / 1000)}s)`);
    }
  }

  // Final state
  const finalState = loadPowerState();
  finalState.serverOnline = true;
  finalState.lastActivityTs = Date.now();
  finalState.lastBootTs = Date.now();
  finalState.bootInProgress = false;
  savePowerState(finalState);

  const totalS = Math.round((Date.now() - start) / 1000);
  steps.push(`🏁 Total boot time: ${totalS}s`);

  // Log session start event
  if (config.sessionLogPath) {
    const stats = await getPowerStats(config).catch(() => null);
    appendSessionEvent(config.sessionLogPath, {
      event: "start",
      sessionId: generateSessionId(),
      timestamp: new Date().toISOString(),
      unixTs: Math.floor(Date.now() / 1000),
      energyKwh: stats?.totalEnergyKwh,
      powerW: stats?.currentPowerW,
      bootTimeS: totalS,
    });
  }

  return { success: true, steps, totalMs: Date.now() - start, cached: false };
}

// ── Idle monitor ────────────────────────────────────────────────────────

let monitorInterval: ReturnType<typeof setInterval> | null = null;

export function startIdleMonitor(config: PowerConfig): void {
  stopIdleMonitor();
  if (!config.enabled) {
    console.log("[power] Idle monitor disabled in config");
    return;
  }

  console.log(
    `[power] Starting idle monitor (timeout: ${config.idleTimeoutMinutes}min, check: ${config.checkIntervalMinutes}min)`
  );

  monitorInterval = setInterval(async () => {
    try {
      await idleMonitorTick(config);
    } catch (e) {
      console.error("[power] Idle monitor tick error:", e);
    }
  }, config.checkIntervalMinutes * 60 * 1000);
}

export function stopIdleMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

export function isIdleMonitorRunning(): boolean {
  return monitorInterval !== null;
}

async function idleMonitorTick(config: PowerConfig): Promise<void> {
  const state = loadPowerState();

  if (state.bootInProgress) return;

  const isOnline = await checkHealth(config.healthUrl);
  const wasOnline = state.serverOnline;
  state.serverOnline = isOnline;

  if (!isOnline) {
    savePowerState(state);
    if (wasOnline) {
      console.log("[power] Server went offline (detected by idle monitor)");
    }
    return;
  }

  if (!wasOnline && isOnline) {
    console.log("[power] Server came online (detected by idle monitor)");
    state.lastActivityTs = Date.now();
    savePowerState(state);
    return;
  }

  // Check for active requests → touch activity
  const runningRequests = await getRunningRequestCount(config.healthUrl);
  if (runningRequests !== null && runningRequests > 0) {
    state.lastActivityTs = Date.now();
    savePowerState(state);
    return;
  }

  if (state.stayOnline) {
    savePowerState(state);
    return;
  }

  const effectiveTimeout = state.idleTimeoutMinutes || config.idleTimeoutMinutes;

  // Protect recent boots
  const wolCooldownMs = 10 * 60 * 1000;
  if (state.lastWolTs && Date.now() - state.lastWolTs < wolCooldownMs) {
    savePowerState(state);
    return;
  }

  const idleMs = Date.now() - state.lastActivityTs;
  const timeoutMs = effectiveTimeout * 60 * 1000;

  if (idleMs >= timeoutMs) {
    console.log(
      `[power] Server idle ${Math.round(idleMs / 60000)}min >= timeout ${effectiveTimeout}min → shutting down`
    );

    const result = await shutdownServer(config.sshHost);
    if (result.success) {
      state.serverOnline = false;
      state.lastShutdownTs = Date.now();
      console.log("[power] Shutdown initiated by idle monitor");

      // Log session end event
      if (config.sessionLogPath && state.lastBootTs) {
        const stats = await getPowerStats(config).catch(() => null);
        const startStats = getLastStartEvent(config.sessionLogPath);
        appendSessionEvent(config.sessionLogPath, {
          event: "end",
          sessionId: startStats?.sessionId ?? generateSessionId(),
          timestamp: new Date().toISOString(),
          unixTs: Math.floor(Date.now() / 1000),
          energyKwh: stats?.totalEnergyKwh,
          durationS: Math.round((Date.now() - state.lastBootTs) / 1000),
          energyUsedKwh: startStats?.energyKwh && stats?.totalEnergyKwh
            ? Math.round((stats.totalEnergyKwh - startStats.energyKwh) * 1000) / 1000
            : undefined,
        });
      }
    } else {
      console.error(`[power] Auto-shutdown failed: ${result.error}`);
    }
  }

  savePowerState(state);
}

// ── Formatting helpers ──────────────────────────────────────────────────

export function formatIdleStatus(config: PowerConfig): string {
  const state = loadPowerState();
  const lines: string[] = ["⚡ GPU Power Status", ""];

  if (state.bootInProgress) {
    lines.push("🟡 Server: booting...");
  } else if (state.serverOnline) {
    lines.push("🟢 Server: online");
  } else {
    lines.push("🔴 Server: offline");
  }

  lines.push(state.stayOnline ? "🔒 Mode: stay-online (auto-shutdown disabled)" : "⏱️ Mode: auto-shutdown");

  const effectiveTimeout = state.idleTimeoutMinutes || config.idleTimeoutMinutes;
  lines.push(`⏰ Idle timeout: ${effectiveTimeout} minutes`);

  if (state.serverOnline) {
    const idleMs = Date.now() - state.lastActivityTs;
    const idleMin = Math.round(idleMs / 60000);
    const remaining = effectiveTimeout - idleMin;

    lines.push(`💤 Idle: ${idleMin} minutes`);
    if (!state.stayOnline && remaining > 0) {
      lines.push(`🔌 Auto-shutdown in: ~${remaining} minutes`);
    } else if (!state.stayOnline && remaining <= 0) {
      lines.push("🔌 Auto-shutdown: imminent (next check)");
    }
  }

  lines.push(isIdleMonitorRunning() ? "👁️ Monitor: active" : "👁️ Monitor: stopped");

  lines.push(`🔌 Wake method: ${config.wakeMethod}`);

  lines.push("");
  if (state.lastBootTs) lines.push(`Last boot: ${formatTimestamp(state.lastBootTs)}`);
  if (state.lastShutdownTs) lines.push(`Last shutdown: ${formatTimestamp(state.lastShutdownTs)}`);
  if (state.lastWolTs) lines.push(`Last wake: ${formatTimestamp(state.lastWolTs)}`);

  return lines.join("\n");
}

export function formatPowerStats(stats: PowerStats): string {
  const lines = [
    "⚡ Power Monitoring",
    "",
    `Socket:         ${stats.socketState}`,
    `Current power:  ${stats.currentPowerW} W`,
    `Session energy: ${stats.sessionEnergyKwh} kWh`,
    `Total energy:   ${stats.totalEnergyKwh} kWh`,
    `Baseline:       ${stats.sessionBaselineKwh} kWh`,
    `Timestamp:      ${stats.timestamp}`,
  ];
  return lines.join("\n");
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const ago = Math.round((Date.now() - ts) / 60000);
  const timeStr = d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  if (ago < 60) return `${timeStr} (${ago}m ago)`;
  if (ago < 1440) return `${timeStr} (${Math.round(ago / 60)}h ago)`;
  return `${timeStr} (${Math.round(ago / 1440)}d ago)`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Config loader ───────────────────────────────────────────────────────

export function loadPowerConfig(endpointsPath: string): PowerConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(endpointsPath, "utf-8"));
    const power = raw?.power;
    if (!power) return null;

    // Determine wake method
    let wakeMethod: WakeMethod = "wol"; // default
    if (power.wakeMethod) {
      wakeMethod = power.wakeMethod as WakeMethod;
    } else if (power.webhookUrl && !power.macAddress) {
      wakeMethod = "webhook";
    } else if (power.webhookUrl && power.macAddress) {
      wakeMethod = "both";
    }

    return {
      wakeMethod,
      macAddress: power.macAddress ? String(power.macAddress) : undefined,
      webhookUrl: power.webhookUrl ? String(power.webhookUrl) : undefined,
      sshHost: String(power.sshHost ?? ""),
      healthUrl: String(power.healthUrl ?? power.vllmHealthUrl ?? ""),
      idleTimeoutMinutes: Number(power.idleTimeoutMinutes) || 30,
      checkIntervalMinutes: Number(power.checkIntervalMinutes) || 5,
      warmupModel: power.warmupModel ? String(power.warmupModel) : undefined,
      enabled: power.enabled !== false,

      // Session logging (optional)
      sessionLogPath: power.sessionLogPath ? String(power.sessionLogPath) : undefined,

      // HA monitoring (all optional)
      haUrl: power.haUrl ? String(power.haUrl) : undefined,
      haTokenFile: power.haTokenFile ? String(power.haTokenFile) : undefined,
      haPowerEntity: power.haPowerEntity ? String(power.haPowerEntity) : undefined,
      haEnergyEntity: power.haEnergyEntity ? String(power.haEnergyEntity) : undefined,
      haBaselineEntity: power.haBaselineEntity ? String(power.haBaselineEntity) : undefined,
      haSocketEntity: power.haSocketEntity ? String(power.haSocketEntity) : undefined,
    };
  } catch {
    return null;
  }
}
