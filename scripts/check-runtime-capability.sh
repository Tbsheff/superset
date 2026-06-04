#!/bin/bash
# Forbids ad-hoc runtime capability booleans / inline capability re-derivation.
# The ONLY sanctioned way to ask "does this provider support X" is the helpers
# in packages/host-service/src/runtime/descriptors/types.ts
# (descriptorSupportsExecution / descriptorSupportsEgress / descriptorSupportsRole).
# Mirrors scripts/check-git-ref-strings.sh.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

failures=0

report_violation() {
	local message="$1"
	local pattern="$2"
	shift 2

	# Don't swallow ripgrep errors — distinguish:
	#   exit 0: matches found → report as violations
	#   exit 1: no matches → silent pass
	#   exit 2: actual rg error (unreadable file, bad regex, etc.) → fail loudly
	local output
	local rg_err
	output=$(rg -n -U --pcre2 "$pattern" "$@" 2>/tmp/rg_stderr.$$) && rc=0 || rc=$?
	rg_err=$(cat /tmp/rg_stderr.$$ 2>/dev/null || true)
	rm -f /tmp/rg_stderr.$$
	case "$rc" in
		0)
			echo "$message"
			echo "$output"
			echo
			failures=1
			;;
		1)
			: # no matches, pass
			;;
		*)
			echo "[runtime-capability] ripgrep scan failed (exit $rc)" >&2
			[[ -n "$rg_err" ]] && echo "$rg_err" >&2
			failures=1
			;;
	esac
}

# The rule applies to the runtime-capability surface — the seam, descriptors,
# and adapters — NOT the whole runtime/ tree (which holds unrelated domain
# booleans like a GitHub PR's `isDraft`/`isCrossRepository`).
CAP_GLOBS=(
	--glob 'packages/host-service/src/runtime/seam/**'
	--glob 'packages/host-service/src/runtime/descriptors/**'
	--glob 'packages/host-service/src/runtime/adapters/**'
	--glob 'packages/host-service/src/runtime/contract/**'
)

# 1) Ban boolean capability fields like `supportsPty:` / `hasPty:` / `canSnapshot:`
report_violation \
	"[runtime-capability] boolean capability fields are forbidden — use discriminated facets in runtime/seam/facets.ts and the descriptorSupports* helpers." \
	"\\b(supports|has|can|is)[A-Z][A-Za-z]*\\s*:\\s*(true|false|boolean)\\b" \
	--type ts \
	"${CAP_GLOBS[@]}" \
	--glob '!**/*.test.ts' \
	--glob '!packages/host-service/src/runtime/descriptors/types.ts'

# 2) Ban inline `.execution.some(` / `.egress.some(` outside descriptors/types.ts
report_violation \
	"[runtime-capability] inline descriptor.some(...) capability checks are forbidden — call descriptorSupports* from runtime/descriptors." \
	"\\.(execution|egress|roles|ingress|onStop|durableStore|activity)\\.(some|includes)\\(" \
	--type ts \
	"${CAP_GLOBS[@]}" \
	--glob '!**/*.test.ts' \
	--glob '!packages/host-service/src/runtime/descriptors/types.ts'

if [[ "$failures" -ne 0 ]]; then
	exit 1
fi
