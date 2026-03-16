#!/usr/bin/env bash
set -euo pipefail

# wechsler.sh — Clean backend switching for LLM inference
#
# Usage:
#   wechsler.sh switch <llama-cpp|vllm>
#   wechsler.sh model  [model_name]    Switch vLLM model (or show current/available)
#   wechsler.sh status [--json]
#   wechsler.sh current
#   wechsler.sh save    [slot_name]
#   wechsler.sh restore [slot_name]
#
# Environment (override via env or config file):
#   GPU_HOST       — GPU server SSH host for reachability check (default: llama-cpp)
#   LLAMA_HOST     — llama-cpp SSH host (default: llama-cpp)
#   LLAMA_PORT     — llama-cpp port (default: 8080)
#   VLLM_HOST      — vllm SSH host (default: vllm)
#   VLLM_PORT      — vllm port (default: 8000)
#   SLOT_NAME      — default slot filename (default: localbot)
#   HEALTH_TIMEOUT — seconds to wait for health (default: 120)
#   SLOT_PATH      — remote path for saved slots (default: /mnt/models/cache/llama-cpp/slots)
#   VLLM_MODELS_DIR — remote dir for per-model env files (default: /etc/vllm-models)
#   VLLM_ENV_FILE  — remote vLLM env file path (default: /etc/vllm-env)

GPU_HOST="${GPU_HOST:-llama-cpp}"
LLAMA_HOST="${LLAMA_HOST:-llama-cpp}"
LLAMA_PORT="${LLAMA_PORT:-8080}"
VLLM_HOST="${VLLM_HOST:-vllm}"
VLLM_PORT="${VLLM_PORT:-8000}"
LOCAL_HOST="${LOCAL_HOST:-llama-local}"
LOCAL_PORT="${LOCAL_PORT:-8080}"
SLOT_NAME="${SLOT_NAME:-localbot}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
SLOT_PATH="${SLOT_PATH:-/mnt/models/cache/llama-cpp/slots}"
LOCAL_SLOT_PATH="${LOCAL_SLOT_PATH:-/models/cache/slots}"
LLAMA_SERVICE="${LLAMA_SERVICE:-llama-server}"
VLLM_SERVICE="${VLLM_SERVICE:-vllm}"
STATE_FILE="${STATE_FILE:-/tmp/wechsler-active-backend}"
LOCK_FILE="${LOCK_FILE:-/tmp/wechsler-switch.lock}"
VLLM_MODELS_DIR="${VLLM_MODELS_DIR:-/etc/vllm-models}"
VLLM_ENV_FILE="${VLLM_ENV_FILE:-/etc/vllm-env}"

LLAMA_URL="http://localhost:${LLAMA_PORT}"
VLLM_URL="http://localhost:${VLLM_PORT}"
LOCAL_URL="http://localhost:${LOCAL_PORT}"

log() { echo "[wechsler] $*"; }
err() { echo "[wechsler] ERROR: $*" >&2; }

write_source_of_truth() {
    local backend="$1"
    local model="${2:-}"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    if [ -n "$model" ]; then
        cat > "$STATE_FILE" <<EOF
{"active_backend":"${backend}","active_model":"${model}","updated_at":"${ts}","writer":"wechsler.sh"}
EOF
    else
        cat > "$STATE_FILE" <<EOF
{"active_backend":"${backend}","updated_at":"${ts}","writer":"wechsler.sh"}
EOF
    fi
}

read_source_of_truth_backend() {
    if [ -f "$STATE_FILE" ]; then
        python3 - <<'PY' "$STATE_FILE" 2>/dev/null || echo "unknown"
import json,sys
try:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        data=json.load(f)
    print(data.get('active_backend','unknown'))
except Exception:
    print('unknown')
PY
    else
        echo "unknown"
    fi
}

acquire_switch_lock() {
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
        err "Another switch/stop operation is in progress (lock: $LOCK_FILE)"
        return 1
    fi
}

# Check if GPU server is reachable via SSH
check_gpu_server() {
    ssh -o ConnectTimeout=3 -o BatchMode=yes "$GPU_HOST" "true" >/dev/null 2>&1
}

# Check if a backend is healthy (run on the target host)
check_health() {
    local host="$1" url="$2" endpoint="$3"
    ssh -o ConnectTimeout=3 "$host" "curl -sf ${url}${endpoint}" >/dev/null 2>&1
}

# Wait for a backend to become healthy
wait_healthy() {
    local host="$1" url="$2" endpoint="$3" elapsed=0
    log "Waiting for ${host} to become healthy..."
    while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
        if check_health "$host" "$url" "$endpoint"; then
            log "${host} is healthy (${elapsed}s)"
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    err "${host} not healthy after ${HEALTH_TIMEOUT}s"
    return 1
}

# Save llama-cpp slot to disk
save_slot() {
    local name="${1:-$SLOT_NAME}"
    log "Saving slot 0 as '${name}'..."
    local result
    result=$(ssh "$LLAMA_HOST" "curl -sf -X POST '${LLAMA_URL}/slots/0?action=save' \
        -H 'Content-Type: application/json' \
        -d '{\"filename\": \"${name}\"}'") || {
        err "Failed to save slot"
        return 1
    }
    log "Saved: ${result}"
}

# Restore llama-cpp slot from disk
restore_slot() {
    local name="${1:-$SLOT_NAME}"
    log "Restoring slot 0 from '${name}'..."
    local result
    result=$(ssh "$LLAMA_HOST" "curl -sf -X POST '${LLAMA_URL}/slots/0?action=restore' \
        -H 'Content-Type: application/json' \
        -d '{\"filename\": \"${name}\"}'") || {
        log "No saved slot '${name}' found, starting fresh"
        return 0
    }
    log "Restored: ${result}"
}

# Check if llama-local is reachable and healthy
check_local_server() {
    ssh -o ConnectTimeout=3 -o BatchMode=yes "$LOCAL_HOST" "true" >/dev/null 2>&1
}

check_local_health() {
    check_health "$LOCAL_HOST" "$LOCAL_URL" "/health"
}

# Save llama-local slot to disk
save_local_slot() {
    local name="${1:-localbot-cpu}"
    log "Saving local slot 0 as '${name}'..."
    local result
    result=$(ssh "$LOCAL_HOST" "curl -sf -X POST '${LOCAL_URL}/slots/0?action=save' \
        -H 'Content-Type: application/json' \
        -d '{\"filename\": \"${name}\"}'") || {
        err "Failed to save local slot"
        return 1
    }
    log "Saved: ${result}"
}

# Restore llama-local slot from disk
restore_local_slot() {
    local name="${1:-localbot-cpu}"
    log "Restoring local slot 0 from '${name}'..."
    local result
    result=$(ssh "$LOCAL_HOST" "curl -sf -X POST '${LOCAL_URL}/slots/0?action=restore' \
        -H 'Content-Type: application/json' \
        -d '{\"filename\": \"${name}\"}'") || {
        log "No saved local slot '${name}' found, starting fresh"
        return 0
    }
    log "Restored: ${result}"
}

# Determine full state
get_state() {
    if ! check_gpu_server; then
        echo "gpu-offline"
        return
    fi
    if check_health "$LLAMA_HOST" "$LLAMA_URL" "/health"; then
        echo "llama-cpp"
    elif check_health "$VLLM_HOST" "$VLLM_URL" "/v1/models"; then
        echo "vllm"
    else
        echo "gpu-idle"
    fi
}

# Determine local server state
get_local_state() {
    if ! check_local_server; then
        echo "local-offline"
        return
    fi
    if check_local_health; then
        echo "local-running"
    else
        echo "local-down"
    fi
}

cmd_status() {
    local json_mode=false
    local fast_mode=false
    for arg in "$@"; do
        [ "$arg" = "--json" ] && json_mode=true
        [ "$arg" = "--fast" ] && fast_mode=true
    done

    local state
    state=$(get_state)

    if $json_mode; then
        local slots_json="null" saved_json="[]" gpu_json="null"
        local local_state local_slots_json="null" local_saved_json="[]"

        if ! $fast_mode && [ "$state" = "llama-cpp" ]; then
            slots_json=$(ssh "$LLAMA_HOST" "curl -sf ${LLAMA_URL}/slots" 2>/dev/null) || slots_json="null"
        fi

        if [ "$state" != "gpu-offline" ]; then
            if ! $fast_mode; then
                # Get saved slot filenames
                saved_json=$(ssh "$LLAMA_HOST" "ls -1 ${SLOT_PATH}/ 2>/dev/null | \
                    python3 -c 'import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))'" 2>/dev/null) || saved_json="[]"
            fi

            # Get GPU memory
            gpu_json=$(ssh "$GPU_HOST" "nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | \
                python3 -c '
import sys, json
gpus = []
for line in sys.stdin:
    parts = [p.strip() for p in line.split(\",\")]
    if len(parts) == 3:
        gpus.append({\"id\": int(parts[0]), \"used_mib\": int(parts[1]), \"total_mib\": int(parts[2])})
print(json.dumps(gpus))
'" 2>/dev/null) || gpu_json="null"
        fi

        # Local server status
        local_state=$(get_local_state)
        if ! $fast_mode && [ "$local_state" = "local-running" ]; then
            local_slots_json=$(ssh "$LOCAL_HOST" "curl -sf ${LOCAL_URL}/slots" 2>/dev/null) || local_slots_json="null"
            local_saved_json=$(ssh "$LOCAL_HOST" "ls -1 ${LOCAL_SLOT_PATH}/ 2>/dev/null | \
                python3 -c 'import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))'" 2>/dev/null) || local_saved_json="[]"
        fi

        local source_backend
        source_backend=$(read_source_of_truth_backend)
        if [ "$source_backend" = "unknown" ] && { [ "$state" = "llama-cpp" ] || [ "$state" = "vllm" ] || [ "$state" = "gpu-idle" ]; }; then
            if [ "$state" = "gpu-idle" ]; then
                source_backend="none"
            else
                source_backend="$state"
            fi
            write_source_of_truth "$source_backend"
        fi

        local source_model
        source_model=$(read_source_of_truth_model)
        cat <<EOF
{"state":"${state}","active_backend":"$([ "$state" = "llama-cpp" ] || [ "$state" = "vllm" ] && echo "$state" || echo "none")","active_model":"${source_model}","source_of_truth":{"backend":"${source_backend}","model":"${source_model}","state_file":"${STATE_FILE}","lock_file":"${LOCK_FILE}"},"slots":${slots_json},"saved_slots":${saved_json},"gpu_memory":${gpu_json},"local":{"state":"${local_state}","slots":${local_slots_json},"saved_slots":${local_saved_json}}}
EOF
    else
        log "State: ${state}"
        log "Source-of-truth backend: $(read_source_of_truth_backend)"
        case "$state" in
            gpu-offline)
                log "GPU server is not reachable"
                ;;
            gpu-idle)
                log "GPU server is up, no backend running"
                ;;
            llama-cpp)
                local slots
                slots=$(ssh "$LLAMA_HOST" "curl -sf ${LLAMA_URL}/slots" 2>/dev/null | \
                    python3 -c "import sys,json; s=json.load(sys.stdin); print(f'Slots: {len(s)}, ctx/slot: {s[0][\"n_ctx\"]}')" 2>/dev/null) || true
                [ -n "$slots" ] && log "$slots"
                ;;
            vllm)
                log "vLLM is active"
                ;;
        esac

        # Show saved slots
        if [ "$state" != "gpu-offline" ]; then
            local saved
            saved=$(ssh "$LLAMA_HOST" "ls -lh ${SLOT_PATH}/ 2>/dev/null" | grep -v ^total || true)
            if [ -n "$saved" ]; then
                log "Saved slots:"
                echo "$saved"
            else
                log "No saved slots on disk"
            fi
        fi

        # Show local server status
        echo ""
        local local_state
        local_state=$(get_local_state)
        case "$local_state" in
            local-offline)
                log "Local (CPU): offline"
                ;;
            local-running)
                log "Local (CPU): running"
                local local_slots
                local_slots=$(ssh "$LOCAL_HOST" "curl -sf ${LOCAL_URL}/slots" 2>/dev/null | \
                    python3 -c "import sys,json; s=json.load(sys.stdin); print(f'Slots: {len(s)}, ctx/slot: {s[0][\"n_ctx\"]}')" 2>/dev/null) || true
                [ -n "$local_slots" ] && log "  $local_slots"
                local local_saved
                local_saved=$(ssh "$LOCAL_HOST" "ls -lh ${LOCAL_SLOT_PATH}/ 2>/dev/null" | grep -v ^total || true)
                if [ -n "$local_saved" ]; then
                    log "  Saved local slots:"
                    echo "$local_saved"
                fi
                ;;
            local-down)
                log "Local (CPU): server reachable but llama-server not running"
                ;;
        esac
    fi
}

cmd_switch() {
    local target="$1"
    acquire_switch_lock || return 1

    local state
    state=$(get_state)

    # Check GPU server is reachable
    if [ "$state" = "gpu-offline" ]; then
        err "GPU server is offline. Power it on first."
        return 1
    fi

    # Already running?
    if [ "$state" = "$target" ]; then
        log "${target} is already active"
        return 0
    fi

    # Stop current backend (with slot save if llama-cpp)
    case "$state" in
        llama-cpp)
            save_slot "$SLOT_NAME" || true
            log "Stopping llama-cpp..."
            ssh "$LLAMA_HOST" "systemctl stop ${LLAMA_SERVICE}" || true
            ;;
        vllm)
            log "Stopping vLLM..."
            ssh "$VLLM_HOST" "systemctl stop ${VLLM_SERVICE}" || true
            ;;
        gpu-idle)
            log "No backend currently active"
            ;;
    esac

    # Start target backend
    case "$target" in
        llama-cpp)
            log "Starting llama-cpp..."
            ssh "$LLAMA_HOST" "systemctl start ${LLAMA_SERVICE}"
            wait_healthy "$LLAMA_HOST" "$LLAMA_URL" "/health"
            restore_slot "$SLOT_NAME" || true
            ;;
        vllm)
            log "Starting vLLM..."
            ssh "$VLLM_HOST" "systemctl start ${VLLM_SERVICE}"
            wait_healthy "$VLLM_HOST" "$VLLM_URL" "/v1/models"
            ;;
        *)
            err "Unknown backend: ${target} (use llama-cpp or vllm)"
            return 1
            ;;
    esac

    # Track which vLLM model is active (read from env file on host)
    local active_model=""
    if [ "$target" = "vllm" ]; then
        active_model=$(ssh "$VLLM_HOST" "grep '^MODEL_NAME=' ${VLLM_ENV_FILE} 2>/dev/null | cut -d= -f2" 2>/dev/null) || true
    fi
    write_source_of_truth "${target}" "${active_model}"
    log "Switched to ${target}"
}

# Read active model from state file
read_source_of_truth_model() {
    if [ -f "$STATE_FILE" ]; then
        python3 - <<'PY' "$STATE_FILE" 2>/dev/null || echo ""
import json,sys
try:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        data=json.load(f)
    print(data.get('active_model',''))
except Exception:
    print('')
PY
    else
        echo ""
    fi
}

# List available vLLM model configs
list_vllm_models() {
    local host="${1:-$VLLM_HOST}"
    ssh -o ConnectTimeout=3 "$host" "ls -1 ${VLLM_MODELS_DIR}/*.env 2>/dev/null | sed 's|.*/||;s|\.env$||'" 2>/dev/null || true
}

# Switch vLLM model (stop → swap env → start)
cmd_model() {
    local model_name="$1"
    acquire_switch_lock || return 1

    # Check if model config exists on remote
    local env_file="${VLLM_MODELS_DIR}/${model_name}.env"
    if ! ssh -o ConnectTimeout=3 "$VLLM_HOST" "test -f ${env_file}" 2>/dev/null; then
        err "No model config '${model_name}' found at ${env_file} on ${VLLM_HOST}"
        log "Available models:"
        list_vllm_models "$VLLM_HOST"
        return 1
    fi

    local current_model
    current_model=$(read_source_of_truth_model)
    if [ "$current_model" = "$model_name" ]; then
        local state
        state=$(get_state)
        if [ "$state" = "vllm" ]; then
            log "Model '${model_name}' is already active"
            return 0
        fi
    fi

    # Stop vLLM if running
    local state
    state=$(get_state)
    if [ "$state" = "vllm" ]; then
        log "Stopping vLLM (current model: ${current_model:-unknown})..."
        ssh "$VLLM_HOST" "systemctl stop ${VLLM_SERVICE}" || true
        sleep 2
    elif [ "$state" = "llama-cpp" ]; then
        save_slot "$SLOT_NAME" || true
        log "Stopping llama-cpp first..."
        ssh "$LLAMA_HOST" "systemctl stop ${LLAMA_SERVICE}" || true
        sleep 2
    fi

    # Swap env file
    log "Activating model config: ${model_name}"
    ssh "$VLLM_HOST" "cp ${env_file} ${VLLM_ENV_FILE}" || {
        err "Failed to copy model config"
        return 1
    }

    # Start vLLM
    log "Starting vLLM with model '${model_name}'..."
    ssh "$VLLM_HOST" "systemctl start ${VLLM_SERVICE}"
    wait_healthy "$VLLM_HOST" "$VLLM_URL" "/v1/models"

    write_source_of_truth "vllm" "$model_name"
    log "Switched to vLLM model '${model_name}'"
}

cmd_stop() {
    acquire_switch_lock || return 1

    local state
    state=$(get_state)

    case "$state" in
        llama-cpp)
            save_slot "$SLOT_NAME" || true
            log "Stopping llama-cpp..."
            ssh "$LLAMA_HOST" "systemctl stop ${LLAMA_SERVICE}"
            write_source_of_truth "none"
            log "Stopped"
            ;;
        vllm)
            log "Stopping vLLM..."
            ssh "$VLLM_HOST" "systemctl stop ${VLLM_SERVICE}"
            write_source_of_truth "none"
            log "Stopped"
            ;;
        gpu-idle)
            write_source_of_truth "none"
            log "No backend running"
            ;;
        gpu-offline)
            log "GPU server is offline"
            ;;
    esac
}

# Main
case "${1:-help}" in
    switch)
        [ -z "${2:-}" ] && { err "Usage: wechsler.sh switch <llama-cpp|vllm>"; exit 1; }
        cmd_switch "$2"
        ;;
    status)
        cmd_status "${2:-}"
        ;;
    model)
        if [ -z "${2:-}" ]; then
            current_model=$(read_source_of_truth_model)
            if [ -n "$current_model" ]; then
                echo "$current_model"
            else
                echo "unknown (no model tracked)"
            fi
            log "Available models on ${VLLM_HOST}:"
            list_vllm_models "$VLLM_HOST"
            exit 0
        fi
        cmd_model "$2"
        ;;
    stop)
        cmd_stop
        ;;
    current)
        echo "$(read_source_of_truth_backend)"
        ;;
    save)
        save_slot "${2:-$SLOT_NAME}"
        ;;
    restore)
        restore_slot "${2:-$SLOT_NAME}"
        ;;
    local-save)
        save_local_slot "${2:-localbot-cpu}"
        ;;
    local-restore)
        restore_local_slot "${2:-localbot-cpu}"
        ;;
    local-status)
        local_state=$(get_local_state)
        log "Local: ${local_state}"
        if [ "$local_state" = "local-running" ]; then
            ssh "$LOCAL_HOST" "curl -sf ${LOCAL_URL}/slots" 2>/dev/null | \
                python3 -c "import sys,json; s=json.load(sys.stdin); print(f'Slots: {len(s)}, ctx/slot: {s[0][\"n_ctx\"]}')" 2>/dev/null || true
        fi
        ;;
    help|--help|-h)
        echo "Usage: wechsler.sh <command> [args]"
        echo ""
        echo "Commands:"
        echo "  switch <llama-cpp|vllm>  Switch active GPU backend (saves/restores slots)"
        echo "  model  [name]            Switch vLLM model (stop→swap env→start) or list available"
        echo "  status [--json]          Show state, GPU info, local info, saved slots"
        echo "  stop                     Stop active GPU backend (saves slots first)"
        echo "  current                  Print source-of-truth backend (llama-cpp|vllm|none|unknown)"
        echo "  save [name]              Save llama-cpp GPU slot to disk"
        echo "  restore [name]           Restore llama-cpp GPU slot from disk"
        echo "  local-save [name]        Save llama-local CPU slot to disk"
        echo "  local-restore [name]     Restore llama-local CPU slot from disk"
        echo "  local-status             Show local CPU server status"
        ;;
    *)
        err "Unknown command: $1"
        exit 1
        ;;
esac
