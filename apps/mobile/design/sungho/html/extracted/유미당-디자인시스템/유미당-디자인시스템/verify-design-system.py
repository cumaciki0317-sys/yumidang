"""Read-only design reference validation; --refresh only after manual document review."""
from pathlib import Path
import argparse, hashlib, json, re, sys
from urllib.parse import unquote, urlsplit
here = Path(__file__).resolve().parent
root = next(p for p in here.parents if (p / "apps/mobile/design/sungho/UI_SCOPE.md").is_file())
parser = argparse.ArgumentParser()
parser.add_argument("--refresh", action="store_true", help="Refresh source fingerprints after the guide and tokens have been reviewed")
parser.add_argument("--references-only", action="store_true", help="Validate entry paths and guide links without source fingerprint validation")
args = parser.parse_args()
if args.refresh and args.references_only:
    parser.error("--refresh and --references-only cannot be combined")
manifest_path = here / "source-manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
tokens = json.loads((here / "design-tokens.json").read_text(encoding="utf-8"))
errors = []
for entry in manifest["entries"]:
    for path in [entry["entry"], *entry["expoFiles"]]:
        if not (root / path).is_file(): errors.append("Missing reference: " + path)
for path, expected in ([] if args.references_only else manifest["sourceFiles"].items()):
    f = root / path
    if not f.is_file():
        errors.append("Missing source: " + path)
        continue
    actual = {"sha256": hashlib.sha256(f.read_bytes()).hexdigest(), "bytes": f.stat().st_size}
    if args.refresh: manifest["sourceFiles"][path] = actual
    elif actual != expected: errors.append("Design source changed; review docs and tokens: " + path)
for name in ["guide.html", "components.html"]:
    text = (here / name).read_text(encoding="utf-8")
    for link in re.findall(r'href="([^"]+)"', text):
        parts = urlsplit(link)
        if parts.scheme or not parts.path: continue
        if not (here / unquote(parts.path)).resolve().exists(): errors.append("Broken link: " + name + " -> " + link)
for name in ["guide.md", "guide.html", "expo-handoff.md", "design-tokens.json", "README.txt"]:
    text = (here / name).read_text(encoding="utf-8")
    if "\ufffd" in text: errors.append("Encoding replacement character: " + name)
if args.refresh and not errors:
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
if errors:
    print("\n".join(errors)); sys.exit(1)
print("Reference-only check: source fingerprints NOT checked." if args.references_only else "Source fingerprints checked.")
print(f"OK: {len(manifest['entries'])} screen references, {0 if args.references_only else len(manifest['sourceFiles'])} source fingerprints, guide links and JSON. Expo runtime/visual QA not included.")
