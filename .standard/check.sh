#!/usr/bin/env bash
# standard-check — conformance check for the AI-Native Development Operating
# Standard v5 (§26.3). Self-contained: runs identically locally
# (`standard-init --check` or `bash .standard/check.sh`) and in CI
# (.github/workflows/standard-conformance.yml).
#
# Track-aware: reads `track:` from .standard.yml. Exit 1 on any FAIL; WARNs never
# fail the build. In a PR context (BASE_REF set), also diff-checks changed
# production files for stub markers.
#
# Kit-owned file: refreshed by `standard-init --upgrade`. Do not hand-edit in
# consumer repos — change it in the kit (~/.qualiency-dev-standard/ci/check.sh) instead.

set -uo pipefail

CHECK_VERSION="5.0.0"
FAILS=0
WARNS=0

# pass <label>
# Print a green PASS line for the named check. Records nothing; passing
# checks never affect the exit code.
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }

# fail <label> <remediation>
# Print a red FAIL line for the named check plus a one-line remediation hint,
# and increment the failure counter that makes the script exit 1 (blocking
# the CI job). Every call must say how to fix the failure, not just that it
# failed.
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; printf '        └─ %s\n' "$2"; FAILS=$((FAILS+1)); }

# warn <label> <note>
# Print a yellow WARN line for the named check plus an explanatory note, and
# increment the warning counter shown in the summary. Warnings never fail
# the run — they mark items that are acceptable but worth attention (§26.3).
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; printf '        └─ %s\n' "$2"; WARNS=$((WARNS+1)); }

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "standard-check: not a git repository" >&2; exit 1; }
cd "$ROOT"

echo "standard-check v$CHECK_VERSION — $(basename "$ROOT")"
echo

# ---- 0. conformance stamp ----------------------------------------------------
# Transition (kit 5.2): repos initialised before the rename carry .bmad.yml;
# accept it with a WARN until `standard-init --upgrade` migrates them.
STAMP=""
if   [[ -f .standard.yml ]]; then STAMP=".standard.yml"
elif [[ -f .bmad.yml ]];     then STAMP=".bmad.yml"; warn "legacy .bmad.yml stamp" "pre-rename layout — run: standard-init --upgrade (migrates to .standard.yml + .standard/)"
fi
if [[ -n "$STAMP" ]]; then
  TRACK="$(sed -n 's/^track:[[:space:]]*//p' "$STAMP" | head -1)"
  KITV="$(sed -n 's/^kit_version:[[:space:]]*//p' "$STAMP" | head -1)"
  STDV="$(sed -n 's/^standard:[[:space:]]*//p' "$STAMP" | head -1 | tr -d '"')"
  if [[ "$STDV" != 5.* ]]; then
    fail "$STAMP stamp" "standard must be 5.x (this checker enforces v5), got '${STDV:-<empty>}' — run: standard-init --upgrade"
    TRACK="${TRACK:-standard}"
  else
    case "$TRACK" in
      quick|standard|deep) pass "$STAMP stamp (standard: $STDV, track: $TRACK, kit: ${KITV:-unknown})" ;;
      *) fail "$STAMP stamp" "track must be quick|standard|deep, got '${TRACK:-<empty>}'"; TRACK="standard" ;;
    esac
  fi
else
  fail ".standard.yml stamp" "missing — run: ~/.qualiency-dev-standard/bin/standard-init"
  TRACK="standard"
fi

# ---- 1. control files (all tracks, §7.1) ------------------------------------
for f in CLAUDE.md SPEC.md SESSION_LOG.md docs/sprint-status.yaml; do
  if [[ -f "$f" ]]; then pass "$f exists"
  else fail "$f exists" "required control file (§7.1) — run standard-init to scaffold"; fi
done
[[ -d docs ]] && pass "docs/ exists" || fail "docs/ exists" "planning artifacts directory (§4.1)"

# ---- 2. secrets hygiene (all tracks, §21) -----------------------------------
TRACKED_ENV="$(git ls-files | grep -E '(^|/)\.env(\..+)?$' | grep -v -E '\.example$|\.template$' || true)"
if [[ -z "$TRACKED_ENV" ]]; then pass "no .env files tracked"
else fail "no .env files tracked" "committed: $(echo "$TRACKED_ENV" | tr '\n' ' ')"; fi

# ---- 3. story file schema (all tracks, §4.3) --------------------------------
STORY_COUNT=0; BAD_STORIES=""
if [[ -d docs/stories ]]; then
  while IFS= read -r sf; do
    [[ "$(basename "$sf")" == "README.md" ]] && continue
    STORY_COUNT=$((STORY_COUNT+1))
    # accepts: "Status: X", "**Status**: X", "**Status:** X", list-item and
    # blockquote prefixes, "In Progress" spelling, and trailing annotation
    # after whitespace ("Review — code merged"). Bounded so "Doneish" or
    # "Draft-old" do not pass.
    if ! grep -qiE '^[[:space:]>-]*\**Status\**:?\**:?[[:space:]]*(Draft|Approved|In ?Progress|Review|Done|Blocked)\**([[:space:]]|$)' "$sf"; then
      BAD_STORIES="$BAD_STORIES $sf"
    fi
  done < <(find docs/stories -name '*.md' -type f 2>/dev/null)
fi
if [[ $STORY_COUNT -eq 0 ]]; then
  pass "story schema (no story files yet)"
elif [[ -z "$BAD_STORIES" ]]; then
  pass "story schema ($STORY_COUNT files, all carry a valid Status: line)"
else
  fail "story schema" "missing/invalid Status: line in:$BAD_STORIES"
fi

# ---- 4. upstream artifacts by track (§26.3) ---------------------------------
# Required only once stories exist — a freshly initialised repo is conformant.
# Brownfield (§5.2–5.3): docs/architecture/current.md or a populated
# docs/architecture/ dir satisfies the architecture gate, and Document-First
# mode legitimately has no brief/PRD → those demote to WARN.
if [[ "$TRACK" != "quick" && $STORY_COUNT -gt 0 ]]; then
  ARCH_FILE=""
  if   [[ -f docs/architecture.md ]];         then ARCH_FILE="docs/architecture.md"
  elif [[ -f docs/architecture/current.md ]]; then ARCH_FILE="docs/architecture/current.md"
  elif [[ -d docs/architecture ]]; then ARCH_FILE="$(find docs/architecture -type f -name '*.md' 2>/dev/null | head -1)"
  fi
  BROWNFIELD=0
  [[ "$ARCH_FILE" == docs/architecture/* ]] && BROWNFIELD=1
  if [[ -n "$ARCH_FILE" ]]; then pass "architecture doc exists ($ARCH_FILE)"
  else fail "architecture doc exists (track: $TRACK)" "stories exist but no docs/architecture.md or docs/architecture/ (§16.1, §5.2)"; fi
  for f in docs/brief.md docs/prd.md; do
    if [[ -f "$f" ]]; then pass "$f exists (track: $TRACK)"
    elif [[ $BROWNFIELD -eq 1 ]]; then
      warn "$f (track: $TRACK)" "absent — acceptable for brownfield Document-First (§5.3); required for PRD-First changes"
    else
      fail "$f exists (track: $TRACK)" "stories exist but this gate artifact is missing (§16.1)"
    fi
  done
  if [[ -n "$ARCH_FILE" ]]; then
    if grep -qiE '^#+.*(threat model|abuse case)' "$ARCH_FILE" docs/architecture/*.md 2>/dev/null; then
      pass "architecture contains a Threat Model section (§17)"
    else
      warn "architecture Threat Model section (§17)" "add the STRIDE-lite section: assets, trust boundaries, top abuse cases"
    fi
  fi
fi
if [[ "$TRACK" == "deep" && $STORY_COUNT -gt 0 && ! -d docs/research ]]; then
  warn "docs/research/ (deep track)" "deep track expects research artifacts (§5.4) or a recorded waiver"
fi

# ---- 5. CI enforcement present (all tracks, §25) ----------------------------
if [[ -f .github/workflows/standard-conformance.yml ]]; then
  pass "standard-conformance workflow installed"
else
  warn "standard-conformance workflow" "not in CI yet — run standard-init --upgrade, then add it to branch-protection required checks"
fi

# ---- 5b. env contract (§13.5, facet 2) --------------------------------------
# The declared env schema and the code must not silently diverge. Counts raw
# `process.env.*` reads in server code outside the declared module.
# `env_contract: warn` (default) reports; `enforce` fails. Promote per repo
# once the module is adopted and the raw reads are migrated (§25).
# stamp_value <key>
# Read one scalar value from the repo's conformance stamp ($STAMP), stripping
# the documented inline comment, surrounding quotes, and whitespace. Prints the
# bare value, or nothing when the key is absent. Exists because the stamp keys
# ship WITH explanatory comments — a naive read of `env_contract: enforce
# # warn|enforce` yields the whole line and silently never matches "enforce".
stamp_value() { # $1 = key
  sed -n "s/^$1:[[:space:]]*//p" "${STAMP:-/dev/null}" 2>/dev/null \
    | head -1 | sed 's/[[:space:]]*#.*$//' | tr -d '"' | xargs 2>/dev/null || true
}
# stamp_mode <key> <default>
# Read a gate-promotion mode (§25.1) from the stamp and validate it. Prints
# "warn" or "enforce": the stamp's value when valid, the given default when the
# key is absent, and the default plus a WARN line when the value is neither —
# a typo must not silently disable a gate.
stamp_mode() { # $1 = key, $2 = default — only warn|enforce are valid
  local v; v="$(stamp_value "$1")"
  case "$v" in
    warn|enforce) printf '%s' "$v" ;;
    "") printf '%s' "$2" ;;
    *) warn "invalid $1: '$v'" "expected warn|enforce — treating as $2"; printf '%s' "$2" ;;
  esac
}
ENV_MODULE="$(stamp_value env_module)"
ENV_MODE="$(stamp_mode env_contract warn)"

if [[ -n "$ENV_MODULE" && ! -f "$ENV_MODULE" ]]; then
  fail "env module exists" "'.standard.yml' declares env_module: $ENV_MODULE but that file is missing"
fi

RAW_COUNT=0; RAW_LIST=""
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  [[ -n "$ENV_MODULE" && "$f" == "$ENV_MODULE" ]] && continue
  case "$f" in
    *__tests__*|*/e2e/*|e2e/*|*/tests/*|tests/*|*/test/*|test/*|*__mocks__*|*fixtures*) continue ;;
    *.test.*|*.spec.*|*.d.ts) continue ;;
    *.config.*|*/scripts/*|scripts/*|*/supabase/functions/_shared/env*) continue ;;
  esac
  # any access form counts: .X, ["X"], and `= process.env` destructuring
  N="$(grep -cE 'process\.env' "$f" 2>/dev/null)" || N=0
  [[ "${N:-0}" -gt 0 ]] && { RAW_COUNT=$((RAW_COUNT+1)); RAW_LIST="$RAW_LIST $f"; }
done < <(git ls-files -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' 2>/dev/null)

if [[ $RAW_COUNT -eq 0 ]]; then
  pass "env contract (no raw process.env reads outside the module)"
elif [[ "$ENV_MODE" == "enforce" ]]; then
  fail "env contract (enforce)" "$RAW_COUNT file(s) read process.env directly:$(echo "$RAW_LIST" | cut -c1-200) — route them through ${ENV_MODULE:-a validated env module}"
else
  warn "env contract ($RAW_COUNT file(s) read process.env directly)" "advisory while .standard.yml has 'env_contract: warn'. Adopt a validated env module, migrate the reads, then set 'env_contract: enforce' (§13.5)"
fi

# ---- 6. PR diff mode: stub markers in ADDED production lines (§13.2, §16.4)
# Runs when BASE_REF is provided (set by the CI workflow on pull_request).
# Fail-closed: an unresolvable base ref fails the check rather than silently
# skipping it. Scans only lines the PR adds, so pre-existing markers in a
# touched file do not block unrelated fixes. Null-delimited paths, so
# filenames with spaces are scanned correctly. Includes SQL migrations.
if [[ -n "${BASE_REF:-}" ]]; then
  if ! git rev-parse -q --verify "origin/$BASE_REF" >/dev/null 2>&1; then
    git fetch --quiet origin "+refs/heads/$BASE_REF:refs/remotes/origin/$BASE_REF" 2>/dev/null || true
  fi
  if ! git rev-parse -q --verify "origin/$BASE_REF" >/dev/null 2>&1; then
    fail "PR stub scan" "cannot resolve origin/$BASE_REF — refusing to pass an unrun check (fail-closed, §25)"
  else
    STUBS=""
    while IFS= read -r -d '' f; do
      case "$f" in
        *__tests__*|*/e2e/*|e2e/*|*/tests/*|tests/*|*/test/*|test/*|*__mocks__*|*fixtures*) continue ;;
        *.test.*|*.spec.*) continue ;;
      esac
      case "$f" in
        *.ts|*.tsx|*.js|*.jsx|*.mjs|*.py|*.go|*.rb|*.swift|*.sql) ;;
        *) continue ;;
      esac
      HITS="$(git diff -U0 "origin/$BASE_REF"...HEAD -- "$f" 2>/dev/null | grep -E '^\+[^+]' | \
        grep -ciE '(//|#|--)[[:space:]]*(TODO|FIXME|HACK|XXX)\b|throw new Error\((["'"'"'])not implemented' || true)"
      [[ "${HITS:-0}" -gt 0 ]] && STUBS="$STUBS $f(+$HITS)"
    done < <(git diff --name-only -z "origin/$BASE_REF"...HEAD 2>/dev/null)
    if [[ -z "$STUBS" ]]; then
      pass "no stub/TODO markers in added production lines"
    else
      fail "no stub/TODO markers in added production lines" "added markers in:$STUBS"
    fi
  fi
fi

# ---- summary ----------------------------------------------------------------
echo
if [[ $FAILS -eq 0 ]]; then
  echo "✅ CONFORMANT — Operating Standard v5 ($WARNS warning(s))"
  exit 0
else
  echo "❌ NOT CONFORMANT — $FAILS failure(s), $WARNS warning(s)"
  echo "   Remediation: run ~/.qualiency-dev-standard/bin/standard-init (scaffold gaps) and fix the items above."
  exit 1
fi
