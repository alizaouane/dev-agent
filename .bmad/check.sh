#!/usr/bin/env bash
# bmad-check — conformance check for the AI-Native Development Operating
# Standard v5 (§26.3). Self-contained: runs identically locally
# (`bmad-init --check` or `bash .bmad/check.sh`) and in CI
# (.github/workflows/standard-conformance.yml).
#
# Track-aware: reads `track:` from .bmad.yml. Exit 1 on any FAIL; WARNs never
# fail the build. In a PR context (BASE_REF set), also diff-checks changed
# production files for stub markers.
#
# Kit-owned file: refreshed by `bmad-init --upgrade`. Do not hand-edit in
# consumer repos — change it in the kit (~/.bmad/ci/bmad-check.sh) instead.

set -uo pipefail

CHECK_VERSION="5.0.0"
FAILS=0
WARNS=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; printf '        └─ %s\n' "$2"; FAILS=$((FAILS+1)); }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; printf '        └─ %s\n' "$2"; WARNS=$((WARNS+1)); }

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "bmad-check: not a git repository" >&2; exit 1; }
cd "$ROOT"

echo "bmad-check v$CHECK_VERSION — $(basename "$ROOT")"
echo

# ---- 0. conformance stamp ----------------------------------------------------
if [[ -f .bmad.yml ]]; then
  TRACK="$(sed -n 's/^track:[[:space:]]*//p' .bmad.yml | head -1)"
  KITV="$(sed -n 's/^kit_version:[[:space:]]*//p' .bmad.yml | head -1)"
  STDV="$(sed -n 's/^standard:[[:space:]]*//p' .bmad.yml | head -1 | tr -d '"')"
  if [[ "$STDV" != 5.* ]]; then
    fail ".bmad.yml stamp" "standard must be 5.x (this checker enforces v5), got '${STDV:-<empty>}' — run: bmad-init --upgrade"
    TRACK="${TRACK:-standard}"
  else
    case "$TRACK" in
      quick|standard|deep) pass ".bmad.yml stamp (standard: $STDV, track: $TRACK, kit: ${KITV:-unknown})" ;;
      *) fail ".bmad.yml stamp" "track must be quick|standard|deep, got '${TRACK:-<empty>}'"; TRACK="standard" ;;
    esac
  fi
else
  fail ".bmad.yml stamp" "missing — run: ~/.bmad/bin/bmad-init"
  TRACK="standard"
fi

# ---- 1. control files (all tracks, §7.1) ------------------------------------
for f in CLAUDE.md SPEC.md SESSION_LOG.md docs/sprint-status.yaml; do
  if [[ -f "$f" ]]; then pass "$f exists"
  else fail "$f exists" "required control file (§7.1) — run bmad-init to scaffold"; fi
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
    if ! grep -qiE '^[[:space:]>-]*\**Status\**:?\**:?[[:space:]]*(Draft|Approved|In ?Progress|Review|Done|Blocked)([[:space:]*]|$)' "$sf"; then
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
  warn "standard-conformance workflow" "not in CI yet — run bmad-init --upgrade, then add it to branch-protection required checks"
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
  echo "   Remediation: run ~/.bmad/bin/bmad-init (scaffold gaps) and fix the items above."
  exit 1
fi
