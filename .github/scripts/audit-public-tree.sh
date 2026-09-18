#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

errors=0
public_count=0
repo_files=()
repository_text_files=()
public_text_files=()
json_files=()

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  errors=$((errors + 1))
}

is_control_file() {
  case "$1" in
    .gitignore|.gitattributes|.github/scripts/audit-public-tree.sh|.github/workflows/public-site-safety.yml)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_public_file() {
  local path="$1"

  case "$path" in
    _headers|vercel.json|app-ads.txt|index.html|privacy/index.html|netshare-proxy/index.html)
      return 0
      ;;
    apps/index.html|apps/site.css)
      return 0
      ;;
    assets/avatar/ichiro-ishii-152.jpg)
      return 0
      ;;
    assets/i18n/i18n.js|assets/i18n/languages.json)
      return 0
      ;;
    config/v1/discovery.json)
      return 0
      ;;
  esac

  [[ "$path" =~ ^apps/[a-z0-9-]+/index\.html$ ]] && return 0
  [[ "$path" =~ ^assets/i18n/locales/[A-Za-z0-9-]+\.json$ ]] && return 0
  [[ "$path" =~ ^config/v1/apps/[a-z0-9-]+\.json$ ]] && return 0
  return 1
}

while IFS= read -r -d '' path; do
  repo_files+=("$path")
done < <(git ls-files --cached --others --exclude-standard -z)

if [ "${#repo_files[@]}" -eq 0 ]; then
  fail "no repository files found"
fi

for path in "${repo_files[@]}"; do
  case "$path" in
    *.html|*.css|*.js|*.json|*.txt|*.md|*.sh|*.yml|*.yaml|.gitignore|.gitattributes|_headers)
      repository_text_files+=("$path")
      ;;
  esac

  if is_control_file "$path"; then
    if ! git check-attr export-ignore -- "$path" | grep -q ': export-ignore: set$'; then
      fail "repository control file is not excluded from git archive: $path"
    fi
    continue
  fi

  if ! is_public_file "$path"; then
    fail "path is not in the public-site allowlist: $path"
    continue
  fi

  if [ ! -e "$path" ]; then
    fail "tracked public file is missing from the working tree: $path"
    continue
  fi

  if [ -L "$path" ] || [ ! -f "$path" ]; then
    fail "public path must be a regular file, not a symlink: $path"
    continue
  fi

  public_count=$((public_count + 1))
  case "$path" in
    *.html|*.css|*.js|*.json|*.txt|*.md|*.sh|*.yml|*.yaml|.gitignore|.gitattributes|_headers)
      public_text_files+=("$path")
      ;;
  esac
  case "$path" in
    *.json)
      json_files+=("$path")
      ;;
  esac
done

if [ "$public_count" -eq 0 ]; then
  fail "public-site allowlist matched no files"
fi

expected_app_ads='google.com, pub-5172471158231865, DIRECT, f08c47fec0942fa0'
if [ ! -f app-ads.txt ]; then
  fail "app-ads.txt is missing"
elif [ "$(wc -l < app-ads.txt | tr -d '[:space:]')" != "1" ]; then
  fail "app-ads.txt must contain exactly one authorized-seller record"
elif [ "$(cat app-ads.txt)" != "$expected_app_ads" ]; then
  fail "app-ads.txt does not match the approved AdMob publisher record"
fi

if ! command -v python3 >/dev/null 2>&1; then
  fail "python3 is required to validate public JSON files"
else
  for path in "${json_files[@]}"; do
    if ! python3 -m json.tool "$path" >/dev/null; then
      fail "invalid JSON: $path"
    fi
  done

  if ! python3 - "$ROOT" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
with (root / "config/v1/discovery.json").open(encoding="utf-8") as handle:
    discovery = json.load(handle)

expected_top = {"apps", "configuration", "generatedAt", "schemaVersion", "studio"}
expected_studio = {"homepage", "label", "name", "privacyUrl", "supportEmail"}
expected_configuration = {
    "discoveryUrls",
    "minimumAgreement",
    "primaryOrigin",
    "revision",
    "trustModel",
    "version",
}
expected_app = {
    "bundleId",
    "category",
    "configPath",
    "configUrl",
    "configUrls",
    "homepage",
    "name",
    "nameZh",
    "platforms",
    "revision",
}
expected_platforms = {"android", "ios"}
expected_platform = {"developmentStatus", "storeStatus", "storeUrl"}
blocked_json_keys = {
    "artifactpath",
    "browserprofile",
    "consoleexport",
    "conversation",
    "credentials",
    "developerprompt",
    "localpath",
    "messages",
    "operationlog",
    "privatekey",
    "prompt",
    "prompts",
    "qastatus",
    "refreshToken".lower(),
    "releasechecklist",
    "runbook",
    "sessioncookie",
    "sessiontoken",
    "systemprompt",
    "testevidence",
    "transcript",
    "accesstoken",
}

def require_keys(value, expected, label):
    if not isinstance(value, dict) or set(value) != expected:
        raise SystemExit(f"{label} fields differ from the public allowlist")

require_keys(discovery, expected_top, "discovery")
require_keys(discovery.get("studio"), expected_studio, "discovery.studio")
require_keys(discovery.get("configuration"), expected_configuration, "discovery.configuration")
apps = discovery.get("apps")
if not isinstance(apps, dict) or not apps:
    raise SystemExit("discovery.apps must be a non-empty object")

slugs = set(apps)
config_slugs = {path.stem for path in (root / "config/v1/apps").glob("*.json")}
page_slugs = {path.parent.name for path in (root / "apps").glob("*/index.html")}
if config_slugs != slugs:
    raise SystemExit("published App config slugs differ from discovery.apps")
if page_slugs != slugs:
    raise SystemExit("published product-page slugs differ from discovery.apps")

for slug, entry in apps.items():
    require_keys(entry, expected_app, f"discovery.apps.{slug}")
    require_keys(entry.get("platforms"), expected_platforms, f"discovery.apps.{slug}.platforms")
    for platform, value in entry["platforms"].items():
        require_keys(value, expected_platform, f"discovery.apps.{slug}.platforms.{platform}")
    if entry.get("configPath") != f"apps/{slug}.json":
        raise SystemExit(f"discovery.apps.{slug}.configPath is not canonical")
    with (root / "config/v1/apps" / f"{slug}.json").open(encoding="utf-8") as handle:
        config = json.load(handle)
    if config.get("app", {}).get("slug") != slug:
        raise SystemExit(f"config/v1/apps/{slug}.json has a mismatched app slug")

def normalize_key(value):
    return "".join(character for character in value.lower() if character.isalnum())

def reject_private_keys(value, location):
    if isinstance(value, dict):
        for key, child in value.items():
            if normalize_key(str(key)) in blocked_json_keys:
                raise SystemExit(f"private JSON key is not allowed at {location}.{key}")
            reject_private_keys(child, f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_private_keys(child, f"{location}[{index}]")

json_paths = [root / "vercel.json", root / "config/v1/discovery.json"]
json_paths.extend((root / "config/v1/apps").glob("*.json"))
json_paths.extend((root / "assets/i18n").glob("*.json"))
json_paths.extend((root / "assets/i18n/locales").glob("*.json"))
for json_path in json_paths:
    with json_path.open(encoding="utf-8") as handle:
        reject_private_keys(json.load(handle), json_path.relative_to(root).as_posix())
PY
  then
    fail "public discovery/config/page inventory is invalid"
  fi

  if ! python3 - "$ROOT/vercel.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    document = json.load(handle)

rule = next(
    (
        item
        for item in document.get("headers", [])
        if item.get("source") in {"/config/:path*", "/config/(.*)"}
    ),
    None,
)
if rule is None:
    raise SystemExit("missing /config wildcard header rule")

headers = {item.get("key", "").lower(): item.get("value") for item in rule.get("headers", [])}
required = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Accept, Content-Type",
    "cross-origin-resource-policy": "cross-origin",
    "content-type": "application/json; charset=utf-8",
}
missing = [key for key, value in required.items() if headers.get(key) != value]
if missing:
    raise SystemExit("missing or invalid Vercel config header(s): " + ", ".join(missing))

app_ads_rule = next(
    (item for item in document.get("headers", []) if item.get("source") == "/app-ads.txt"),
    None,
)
if app_ads_rule is None:
    raise SystemExit("missing /app-ads.txt header rule")
app_ads_headers = {
    item.get("key", "").lower(): item.get("value")
    for item in app_ads_rule.get("headers", [])
}
required_app_ads = {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "public, max-age=3600, must-revalidate",
    "x-content-type-options": "nosniff",
}
missing_app_ads = [
    key for key, value in required_app_ads.items()
    if app_ads_headers.get(key) != value
]
if missing_app_ads:
    raise SystemExit(
        "missing or invalid Vercel app-ads header(s): " + ", ".join(missing_app_ads)
    )
PY
  then
    fail "vercel.json does not enforce the required /config CORS policy"
  fi
fi

required_netlify_headers=(
  '/app-ads.txt'
  '  Content-Type: text/plain; charset=utf-8'
  '  Cache-Control: public, max-age=3600, must-revalidate'
  '  X-Content-Type-Options: nosniff'
  '/config/*'
  '  Access-Control-Allow-Origin: *'
  '  Access-Control-Allow-Methods: GET, HEAD, OPTIONS'
  '  Access-Control-Allow-Headers: Accept, Content-Type'
  '  Cross-Origin-Resource-Policy: cross-origin'
  '  Content-Type: application/json; charset=utf-8'
)
for line in "${required_netlify_headers[@]}"; do
  if ! grep -Fqx -- "$line" _headers; then
    fail "_headers is missing required line: $line"
  fi
done

# These patterns target credential formats, not public AdMob identifiers such as
# ca-app-pub-... values, which are expected in the published configuration.
secret_patterns=(
  '-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----'
  '-----BEGIN PGP PRIVATE '"KEY BLOCK-----"
  '(^|[^[:alnum:]_])github_pat_[[:alnum:]_]{20,}'
  '(^|[^[:alnum:]_])gh[pousr]_[[:alnum:]]{20,}'
  '(^|[^[:alnum:]])(AKIA|ASIA)[0-9A-Z]{16}([^[:alnum:]]|$)'
  '(^|[^[:alnum:]_-])AIza[0-9A-Za-z_-]{35}([^[:alnum:]_-]|$)'
  '(^|[^[:alnum:]_-])GOCSPX-[0-9A-Za-z_-]{20,}'
  '(^|[^[:alnum:]_-])xox[baprs]-[0-9A-Za-z-]{10,}'
  '(^|[^[:alnum:]_-])(sk|rk)_live_[0-9A-Za-z]{16,}'
  '(^|[^[:alnum:]_-])glpat-[0-9A-Za-z_-]{20,}'
  '(^|[^[:alnum:]_-])npm_[0-9A-Za-z]{20,}'
  '(^|[^[:alnum:]_-])dop_v1_[0-9a-f]{32,}'
  'Bearer[[:space:]]+[0-9A-Za-z._~-]{20,}'
)

for pattern in "${secret_patterns[@]}"; do
  matches="$(LC_ALL=C grep -IlE -- "$pattern" "${public_text_files[@]}" || true)"
  if [ -n "$matches" ]; then
    printf 'ERROR: possible credential material found in public file(s):\n%s\n' "$matches" >&2
    errors=$((errors + 1))
  fi
done

# Public pages and JSON must not contain local paths, prompt/session material,
# or private advertising/store operations notes even when their paths are allowed.
private_boundary_patterns=(
  '/Users/'
  'file:///+(Users|home|private|tmp)/|file:///[A-Za-z]:/'
  '<INSTRUCTIONS>|#[[:space:]]+AGENTS\.md'
  'Message Type:|Task name:|BUILD SUCCEEDED'
  'Cookie:|Set-Cookie:'
  'session(id|token|cookie)[[:space:]]*='
  '(^|[^[:alnum:]_])(system|developer|assistant|user)[[:space:]_-]*prompt([^[:alnum:]_]|$)'
  '(^|[^[:alnum:]_])(conversation|thread|chat|browser|authentication)[[:space:]_-]*(log|history|transcript|session)([^[:alnum:]_]|$)'
  '(^|[^[:alnum:]_])(registration[[:space:]_-]*plan|batch[[:space:]_-]*report|console[[:space:]_-]*(status|export)|review[[:space:]_-]*notes?)([^[:alnum:]_]|$)'
  'physical-device end-to-end validation is pending'
  'admob-registration-results'
  'LLM/AIProjects|LLM/AIOutputs|\.codex/'
)

for pattern in "${private_boundary_patterns[@]}"; do
  matches="$(LC_ALL=C grep -IlE -- "$pattern" "${public_text_files[@]}" || true)"
  if [ -n "$matches" ]; then
    printf 'ERROR: possible private operational content found in public file(s):\n%s\n' "$matches" >&2
    errors=$((errors + 1))
  fi
done

if [ "$errors" -ne 0 ]; then
  printf 'Public tree audit failed with %d error(s).\n' "$errors" >&2
  exit 1
fi

printf 'Public tree audit passed: %d allowlisted site files checked.\n' "$public_count"
