#!/usr/bin/env bash
# Actualiza url y sha256 de Formula/dockploy-agent.rb a un tag de GitHub (vX.Y.Z).
set -euo pipefail

tag="${1:?uso: scripts/bump-homebrew-formula.sh v0.3.0}"
if [[ ! "$tag" =~ ^v[0-9] ]]; then
  echo "el tag debe ser vX.Y.Z" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
formula="$root/Formula/dockploy-agent.rb"
repo="tadeodev/Dockploy-agente"
url="https://github.com/${repo}/archive/refs/tags/${tag}.tar.gz"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

curl -fsSL -o "$tmp" "$url"
sha="$(shasum -a 256 "$tmp" | awk '{print $1}')"

python3 - "$formula" "$url" "$sha" <<'PY'
import re
import sys
from pathlib import Path

path, url, sha = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
text = path.read_text()
text, n_url = re.subn(r'url "[^"]+"', f'url "{url}"', text, count=1)
text, n_sha = re.subn(r'sha256 "[a-fA-F0-9]+"', f'sha256 "{sha}"', text, count=1)
text = re.sub(r'\n  version "[^"]+"', "", text, count=1)
if n_url != 1 or n_sha != 1:
    raise SystemExit("no se pudo actualizar url/sha256 en la fórmula")
path.write_text(text)
print(f"actualizado {path.name}")
print(f"  url    {url}")
print(f"  sha256 {sha}")
PY
