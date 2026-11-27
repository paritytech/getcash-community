#!/usr/bin/env bash
# Runs a command and stops its whole process tree when the tree's resident memory exceeds a
# limit, or when the system's free-memory level drops too low (macOS: kern.memorystatus_level,
# Linux: MemAvailable as a percentage of MemTotal).
# Usage: memcap.sh <limit-gb> <log-file> -- <command> [args...]
set -uo pipefail

limit_kb=$(($1 * 1024 * 1024))
log=$2
shift 2
[ "${1:-}" = "--" ] && shift

if [ "$(uname)" = Darwin ]; then
    default_min_free_level=15
    free_level() { sysctl -n kern.memorystatus_level; }
else
    default_min_free_level=5
    free_level() { awk '/^MemTotal:/ {total = $2} /^MemAvailable:/ {avail = $2} END {print int(avail * 100 / total)}' /proc/meminfo; }
fi
min_free_level=${MEMCAP_MIN_FREE_LEVEL:-$default_min_free_level}
interval=${MEMCAP_INTERVAL:-2}
report_every=${MEMCAP_REPORT_EVERY:-30}

stamp() { date '+%F %T'; }

tree_pids() {
    ps -axo pid=,ppid= | awk -v root="$1" '
        { parent[$1] = $2 }
        END {
            for (pid in parent) {
                p = pid
                while (p != "" && p > 1) {
                    if (p == root) { print pid; break }
                    p = parent[p]
                }
            }
        }'
}

tree_rss_kb() {
    ps -axo pid=,ppid=,rss= | awk -v root="$1" '
        { parent[$1] = $2; rss[$1] = $3 }
        END {
            total = 0
            for (pid in parent) {
                p = pid
                while (p != "" && p > 1) {
                    if (p == root) { total += rss[pid]; break }
                    p = parent[p]
                }
            }
            print total
        }'
}

stop_tree() {
    local pids
    pids=$(tree_pids "$1")
    [ -n "$pids" ] && kill -TERM $pids 2>/dev/null
    sleep 5
    pids=$(tree_pids "$1")
    [ -n "$pids" ] && kill -KILL $pids 2>/dev/null
}

"$@" &
child=$!
trap 'echo "$(stamp) interrupted, stopping tree" >>"$log"; stop_tree "$child"; exit 130' INT TERM
echo "$(stamp) started pid $child, limit $((limit_kb / 1024)) MB: $*" >>"$log"

peak=0
ticks=0
while kill -0 "$child" 2>/dev/null; do
    rss=$(tree_rss_kb "$child")
    [ "$rss" -gt "$peak" ] && peak=$rss
    level=$(free_level)
    if [ "$rss" -gt "$limit_kb" ]; then
        echo "$(stamp) stopping: tree uses $((rss / 1024)) MB, limit $((limit_kb / 1024)) MB" >>"$log"
        stop_tree "$child"
        exit 137
    fi
    if [ "$level" -lt "$min_free_level" ]; then
        echo "$(stamp) stopping: system free-memory level $level%, minimum $min_free_level%" >>"$log"
        stop_tree "$child"
        exit 137
    fi
    ticks=$((ticks + 1))
    if [ $((ticks % report_every)) -eq 0 ]; then
        echo "$(stamp) tree $((rss / 1024)) MB, peak $((peak / 1024)) MB, system free level $level%" >>"$log"
    fi
    sleep "$interval"
done

wait "$child"
status=$?
echo "$(stamp) exited with status $status, peak $((peak / 1024)) MB" >>"$log"
exit $status
