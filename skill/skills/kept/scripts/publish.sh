#!/usr/bin/env bash
# kept: publish a file or a folder and get a public link. https://kept.host/agents
#
#   publish.sh [flags] <file-or-folder>                 publish (a draft, or into your account with a key)
#   publish.sh --replace <manage_token|slug> [flags] <path>   new content, same link (a page published without a key)
#   publish.sh --page <slug> [flags] <path>             new content, same link (a page in your account)
#   publish.sh delete <manage_token|slug>               take a page published without a key offline
#   publish.sh delete --page <slug>                     take a page in your account offline
#   publish.sh login <email>                            email a 6-digit sign-in code
#   publish.sh login --code <code>                      trade the code for an API key, saved to ~/.kept/credentials
#
# Flags: --title --model --tool --prompt --readme --source-url --remix-of <value>, --spa (folders)
# A file publishes as one page; a folder as a site with index.html at its root.
#
# Key: $KEPT_API_KEY, else ~/.kept/credentials. Never printed.
# Tokens of pages published without a key: ~/.kept/drafts.json (0600).
# Origin: $KEPT_BASE_URL (default https://kept.host).
#
# Exit: 0 ok · 2 your input (bad flag, missing file, missing_index, too large, …)
#       3 rate limited or publishing paused (prints how long to wait) · 4 network or server
set -euo pipefail

BASE="${KEPT_BASE_URL:-https://kept.host}"
BASE="${BASE%/}"
KEPT_DIR="$HOME/.kept"
DRAFTS="$KEPT_DIR/drafts.json"
CREDENTIALS="$KEPT_DIR/credentials"
PENDING_LOGIN="$KEPT_DIR/login-email"

# Every inline request body is capped at this many bytes on the wire
# (@kept/shared INLINE_BODY_MAX_BYTES; the drift test keeps them equal).
INLINE_BODY_MAX_BYTES=10485760

die() { echo "kept: $2" >&2; exit "$1"; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# --- the agent, for X-Kept-Client: {agent}/skill ------------------------------

detect_agent() {
  local name
  if [ -n "${CLAUDECODE:-}" ]; then echo "claude-code"; return; fi
  for name in $(compgen -e); do
    case "$name" in
      CODEX_*) echo "codex"; return ;;
      CURSOR_*) echo "cursor"; return ;;
    esac
  done
  if [ -n "${GEMINI_CLI:-}" ]; then echo "gemini-cli"; return; fi
  if [ -n "${OPENCODE:-}" ]; then echo "opencode"; return; fi
  echo "unknown"
}
CLIENT="$(detect_agent)/skill"

# --- scratch space -------------------------------------------------------------

umask 077
TMP="$(mktemp -d "${TMPDIR:-/tmp}/kept.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# --- JSON without jq -----------------------------------------------------------

# sed expressions that escape one line for a JSON string: \ " TAB CR and the
# other C0 controls. The lines are joined with \n by json_string.
SED_ESCAPES=(-e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$(printf '\t')/\\\\t/g" -e "s/$(printf '\r')/\\\\r/g")
for code in $(seq 1 31); do
  case "$code" in 9 | 10 | 13) continue ;; esac
  char="$(printf '%b' "\\0$(printf '%03o' "$code")")"
  SED_ESCAPES+=(-e "s/$char/\\\\u$(printf '%04x' "$code")/g")
done

# The contents of file $1 as a JSON string literal.
json_string() {
  printf '"'
  LC_ALL=C sed "${SED_ESCAPES[@]}" "$1" | LC_ALL=C awk 'NR > 1 { printf "%s", "\\n" } { printf "%s", $0 }'
  if [ -s "$1" ] && [ "$(tail -c 1 "$1" | od -An -tx1 | tr -d ' \n')" = "0a" ]; then printf '\\n'; fi
  printf '"'
}

# $1 as a JSON string literal.
json_value() {
  printf '%s' "$1" >"$TMP/value"
  json_string "$TMP/value"
}

# A string field of a flat JSON object in file $2 (kept's answers are flat).
json_field() {
  LC_ALL=C sed -En 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' "$2" | head -n 1
}

# A number or boolean field of a flat JSON object in file $2.
json_scalar() {
  LC_ALL=C sed -En 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*([0-9a-z.]*).*/\1/p' "$2" | head -n 1
}

# --- arguments -----------------------------------------------------------------

COMMAND="publish"
REPLACE=""
PAGE=""
SPA=""
CODE=""
TARGET=""
PROVENANCE_KEYS=()
PROVENANCE_VALUES=()

need_value() { [ "$#" -ge 2 ] && [ -n "$2" ] || die 2 "$1 needs a value."; }

case "${1:-}" in
  login | delete) COMMAND="$1"; shift ;;
  "" | -h | --help) usage ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --replace) need_value "$@"; REPLACE="$2"; shift 2 ;;
    --page) need_value "$@"; PAGE="$2"; shift 2 ;;
    --code) need_value "$@"; CODE="$2"; shift 2 ;;
    --spa) SPA="true"; shift ;;
    --title | --model | --tool | --prompt | --readme | --source-url | --remix-of)
      need_value "$@"
      key="${1#--}"
      PROVENANCE_KEYS+=("${key//-/_}")
      PROVENANCE_VALUES+=("$2")
      shift 2
      ;;
    -h | --help) usage ;;
    -*) die 2 "unknown flag $1. Run publish.sh --help." ;;
    *)
      [ -z "$TARGET" ] || die 2 "one path at a time."
      TARGET="$1"
      shift
      ;;
  esac
done

# --- the key -------------------------------------------------------------------

API_KEY="${KEPT_API_KEY:-}"
if [ -z "$API_KEY" ] && [ -f "$CREDENTIALS" ]; then
  API_KEY="$(sed -n 's/^api_key=//p' "$CREDENTIALS" | head -n 1)"
fi
if [ -n "$API_KEY" ]; then
  # A header file, so the key never appears in the process list.
  printf 'Authorization: Bearer %s\n' "$API_KEY" >"$TMP/auth"
fi

# --- HTTP ----------------------------------------------------------------------

# request METHOD URL [curl args…] → the status in $STATUS, the body in $TMP/response.
request() {
  local method="$1" url="$2"
  shift 2
  STATUS="$(curl -sS -o "$TMP/response" -w '%{http_code}' -X "$method" "$url" \
    -H "X-Kept-Client: $CLIENT" "$@")" || die 4 "could not reach $BASE. Check the connection and try again."
}

# The same, with the key's Authorization header.
keyed_request() {
  local method="$1" url="$2"
  shift 2
  request "$method" "$url" -H "@$TMP/auth" "$@"
}

# Exit with the right code for a non-2xx answer.
fail() {
  local error message retry
  error="$(json_field error "$TMP/response")"
  message="$(json_field message "$TMP/response")"
  retry="$(json_scalar retry_after_seconds "$TMP/response")"
  if [ "$STATUS" = "429" ] || [ "$error" = "rate_limited" ] || [ "$error" = "publishing_paused" ]; then
    die 3 "${error:-rate_limited}: ${message:-try again later.} Wait ${retry:-60} seconds before trying again."
  fi
  case "$STATUS" in
    4??) die 2 "${error:-error $STATUS}: ${message:-the request was refused.}" ;;
    *) die 4 "${error:-error $STATUS}: ${message:-kept did not answer. Try again in a minute.}" ;;
  esac
}

ok() { case "$STATUS" in 2??) return 0 ;; *) return 1 ;; esac; }

# --- ~/.kept/drafts.json: one page per line --------------------------------------

drafts_lines() { if [ -f "$DRAFTS" ]; then grep '^{' "$DRAFTS" | sed 's/,$//' || true; fi; }

# Drop slug $1, then add line $2 when given.
drafts_write() {
  local slug="$1" line="${2:-}"
  mkdir -p "$KEPT_DIR"
  {
    drafts_lines | grep -v "\"slug\":\"$slug\"" || true
    if [ -n "$line" ]; then echo "$line"; fi
  } >"$TMP/drafts"
  {
    echo "["
    sed '$!s/$/,/' "$TMP/drafts"
    echo "]"
  } >"$TMP/drafts.json"
  mv "$TMP/drafts.json" "$DRAFTS"
  chmod 600 "$DRAFTS"
}

# The manage_token for $1 — a slug in drafts.json, else $1 itself.
manage_token_for() {
  local token
  token="$(drafts_lines | grep "\"slug\":\"$1\"" | sed -n 's/.*"manage_token":"\([^"]*\)".*/\1/p' | head -n 1)"
  echo "${token:-$1}"
}

# --- login (D7) ------------------------------------------------------------------

if [ "$COMMAND" = "login" ]; then
  mkdir -p "$KEPT_DIR"
  if [ -z "$CODE" ]; then
    [ -n "$TARGET" ] || die 2 "usage: publish.sh login <email>, then publish.sh login --code <code>."
    printf '{"email":%s}' "$(json_value "$TARGET")" >"$TMP/body"
    request POST "$BASE/api/agent/request-code" -H "Content-Type: application/json" --data-binary "@$TMP/body"
    ok || fail
    printf '%s\n' "$TARGET" >"$PENDING_LOGIN"
    echo "kept: if $TARGET can sign in, a 6-digit code is on its way. Ask the user for it, then run:"
    echo "  publish.sh login --code <code>"
    exit 0
  fi
  [ -f "$PENDING_LOGIN" ] || die 2 "run publish.sh login <email> first."
  email="$(head -n 1 "$PENDING_LOGIN")"
  key_name="$(printf '%s on %s' "${CLIENT%/skill}" "$(hostname 2>/dev/null || echo this machine)" | cut -c 1-60)"
  printf '{"email":%s,"code":%s,"keyName":%s}' \
    "$(json_value "$email")" "$(json_value "$CODE")" "$(json_value "$key_name")" >"$TMP/body"
  request POST "$BASE/api/agent/verify-code" -H "Content-Type: application/json" --data-binary "@$TMP/body"
  ok || fail
  key="$(json_field api_key "$TMP/response")"
  [ -n "$key" ] || die 4 "kept answered without a key. Try again."
  printf 'api_key=%s\n' "$key" >"$CREDENTIALS"
  chmod 600 "$CREDENTIALS"
  rm -f "$PENDING_LOGIN"
  echo "kept: signed in as $email. The key \"$(json_field key_name "$TMP/response")\" is saved in ~/.kept/credentials."
  echo "Pages now publish into the account."
  exit 0
fi

# --- delete ----------------------------------------------------------------------

if [ "$COMMAND" = "delete" ]; then
  if [ -n "$PAGE" ]; then
    [ -n "$API_KEY" ] || die 2 "--page needs a key: set KEPT_API_KEY or run publish.sh login <email>."
    keyed_request DELETE "$BASE/api/v1/pages/$PAGE"
    ok || fail
    echo "kept: $PAGE is offline."
    exit 0
  fi
  [ -n "$TARGET" ] || die 2 "usage: publish.sh delete <manage_token|slug> or publish.sh delete --page <slug>."
  token="$(manage_token_for "$TARGET")"
  request DELETE "$BASE/api/anon/$token"
  ok || fail
  slug="$(drafts_lines | grep "\"manage_token\":\"$token\"" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p' | head -n 1)"
  if [ -n "$slug" ]; then drafts_write "$slug"; fi
  echo "kept: ${slug:-the page} is offline."
  exit 0
fi

# --- publish ---------------------------------------------------------------------

[ -n "$TARGET" ] || usage
[ -e "$TARGET" ] || die 2 "$TARGET does not exist."
[ -z "$REPLACE" ] || [ -z "$PAGE" ] || die 2 "use --replace or --page, not both."
if [ -n "$PAGE" ] && [ -z "$API_KEY" ]; then
  die 2 "--page needs a key: set KEPT_API_KEY or run publish.sh login <email>. For a page published without a key, use --replace."
fi

# Where this publish goes. --replace is always the keyless page's own token.
if [ -n "$REPLACE" ]; then
  MODE="anon-replace"
  URL="$BASE/api/anon/$(manage_token_for "$REPLACE")/replace"
  METHOD="POST"
elif [ -n "$PAGE" ]; then
  MODE="keyed"
  URL="$BASE/api/v1/pages/$PAGE"
  METHOD="PUT"
elif [ -n "$API_KEY" ]; then
  MODE="keyed"
  URL="$BASE/api/v1/pages"
  METHOD="POST"
else
  MODE="anon"
  URL="$BASE/api/publish"
  METHOD="POST"
fi

send() {
  if [ "$MODE" = "keyed" ]; then keyed_request "$METHOD" "$URL" "$@"; else request "$METHOD" "$URL" "$@"; fi
}

# The provenance as JSON members (`,"model":"…"`) for a JSON body.
provenance_json() {
  local i
  for i in "${!PROVENANCE_KEYS[@]}"; do
    printf ',"%s":%s' "${PROVENANCE_KEYS[$i]}" "$(json_value "${PROVENANCE_VALUES[$i]}")"
  done
}

# too_large CODE HINT
too_large() {
  die 2 "$1: the request is over $((INLINE_BODY_MAX_BYTES / 1048576)) MB. $2"
}

if [ -f "$TARGET" ]; then
  # One page: JSON {"html": "…"}.
  {
    printf '{"html":'
    json_string "$TARGET"
    provenance_json
    printf '}'
  } >"$TMP/body"
  [ "$(wc -c <"$TMP/body")" -le "$INLINE_BODY_MAX_BYTES" ] || too_large page_too_large "One page cannot be this large."
  send -H "Content-Type: application/json" --data-binary "@$TMP/body"
else
  # A site: a zip of the folder, as a multipart `archive` part.
  [ -d "$TARGET" ] || die 2 "$TARGET is not a file or a folder."
  [ -n "$(ls -A "$TARGET")" ] || die 2 "missing_index: $TARGET is empty; a site needs index.html at its root."
  ZIP="$TMP/site.zip"
  if command -v zip >/dev/null 2>&1; then
    (cd "$TARGET" && zip -r -X -q "$ZIP" . -x '.git/*' '*/.git/*' '.DS_Store' '*/.DS_Store')
  elif command -v python3 >/dev/null 2>&1; then
    python3 -I - "$TARGET" "$ZIP" <<'PY'
import os, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
    for folder, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d != ".git")
        for name in sorted(files):
            if name == ".DS_Store":
                continue
            path = os.path.join(folder, name)
            archive.write(path, os.path.relpath(path, root))
PY
  else
    die 2 "publishing a folder needs zip or python3."
  fi

  size="$(wc -c <"$ZIP" | tr -d ' ')"
  extra=4096
  for value in ${PROVENANCE_VALUES[@]+"${PROVENANCE_VALUES[@]}"}; do extra=$((extra + ${#value} * 4)); done

  if [ $((size + extra)) -le "$INLINE_BODY_MAX_BYTES" ]; then
    form=(-F "archive=@$ZIP;type=application/zip;filename=site.zip")
    if [ -n "$SPA" ]; then form+=(--form-string "spa=true"); fi
    for i in "${!PROVENANCE_KEYS[@]}"; do form+=(--form-string "${PROVENANCE_KEYS[$i]}=${PROVENANCE_VALUES[$i]}"); done
    send "${form[@]}"
  else
    [ "$MODE" = "keyed" ] || too_large site_too_large "Larger sites need an account: run publish.sh login <email>, or set KEPT_API_KEY."
    # Keyed: a presigned upload, then publish the upload_id.
    printf '{"size_bytes":%s}' "$size" >"$TMP/body"
    keyed_request POST "$BASE/api/v1/uploads" -H "Content-Type: application/json" --data-binary "@$TMP/body"
    ok || fail
    upload_id="$(json_field upload_id "$TMP/response")"
    upload_url="$(json_field upload_url "$TMP/response" | sed 's/\\\//\//g')"
    upload_status="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT -H "Content-Type: application/zip" \
      -T "$ZIP" "$upload_url")" || die 4 "the upload did not finish. Try again."
    case "$upload_status" in 2??) ;; *) die 4 "the upload was refused ($upload_status). Try again." ;; esac
    {
      printf '{"upload_id":"%s"' "$upload_id"
      if [ -n "$SPA" ]; then printf ',"spa":true'; fi
      provenance_json
      printf '}'
    } >"$TMP/body"
    send -H "Content-Type: application/json" --data-binary "@$TMP/body"
  fi
fi

ok || fail

# --- the answer -------------------------------------------------------------------

live="$(json_field live_url "$TMP/response")"
slug="$(json_field slug "$TMP/response")"
expires="$(json_field expires_at "$TMP/response")"

case "$MODE" in
  anon)
    token="$(json_field anonToken "$TMP/response")"
    claim="$(json_field claim_url "$TMP/response")"
    drafts_write "$slug" "{\"slug\":\"$slug\",\"manage_token\":\"$token\",\"live_url\":\"$live\",\"claim_url\":\"$claim\",\"expires_at\":\"$expires\"}"
    echo "Live:  $live"
    echo "Claim: $claim"
    echo "This is a draft until $expires. Open the claim link to keep it for good."
    echo "manage_token: $token (saved in ~/.kept/drafts.json; change this page with: publish.sh --replace $slug <path>)"
    ;;
  anon-replace)
    token="$(manage_token_for "$REPLACE")"
    claim="$(drafts_lines | grep "\"manage_token\":\"$token\"" | sed -n 's/.*"claim_url":"\([^"]*\)".*/\1/p' | head -n 1)"
    drafts_write "$slug" "{\"slug\":\"$slug\",\"manage_token\":\"$token\",\"live_url\":\"$live\",\"claim_url\":\"$claim\",\"expires_at\":\"$expires\"}"
    echo "Live:  $live (replaced)"
    if [ -n "$claim" ]; then echo "Claim: $claim"; fi
    if [ -n "$expires" ]; then echo "This is a draft until $expires."; else echo "This page is kept."; fi
    ;;
  keyed)
    echo "Live:   $live"
    echo "Studio: $(json_field studio_url "$TMP/response")"
    if [ "$(json_scalar kept "$TMP/response")" = "true" ]; then
      echo "Kept in the account."
    else
      echo "A draft in the account until $expires (no free kept slot). Keep it from the studio."
    fi
    ;;
esac
