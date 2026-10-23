"""사용자가 승인한 전용 에뮬레이터의 예시 UI 검증. 실기기·외부 회원 대상 아님."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

ADB = "/Users/b/Library/Android/sdk/platform-tools/adb"
SERIAL = "emulator-5560"
ROOT = Path(__file__).resolve().parent

def adb(*args):
    return subprocess.check_output([ADB, "-s", SERIAL, *args], timeout=40)

def check_target():
    name = adb("emu", "avd", "name").decode().splitlines()[0].strip()
    if name != "Yumidang_UX_API35":
        raise RuntimeError("전용 에뮬레이터가 아니므로 중단")

def tree():
    # A failed idle capture can leave an old file behind. Never use that as current UI.
    adb("shell", "rm", "-f", "/sdcard/yumidang-ux-window.xml")
    result = adb("shell", "uiautomator", "dump", "/sdcard/yumidang-ux-window.xml")
    if b"dumped to" not in result.lower():
        raise RuntimeError("UI hierarchy was not captured; old XML is not reused")
    raw = adb("shell", "cat", "/sdcard/yumidang-ux-window.xml")
    return ET.fromstring(raw), raw

def snapshot(label):
    if not re.fullmatch(r"[a-z0-9_-]+", label):
        raise ValueError("invalid evidence label")
    doc, raw = tree()
    (ROOT / f"{label}.xml").write_bytes(raw)
    (ROOT / f"{label}.png").write_bytes(adb("exec-out", "screencap", "-p"))
    rows = []
    for node in doc.iter("node"):
        if node.get("text") or node.get("content-desc") or node.get("scrollable") == "true":
            rows.append({k: node.get(k) for k in ["text", "content-desc", "class", "bounds", "clickable", "focused", "scrollable"]})
    print(json.dumps(rows, ensure_ascii=False))

if __name__ == "__main__":
    check_target()
    action, *args = sys.argv[1:]
    if action == "snapshot":
        snapshot(args[0])
    elif action == "screen":
        if not re.fullmatch(r"[a-z0-9_-]+", args[0]):
            raise ValueError("invalid evidence label")
        (ROOT / f"{args[0]}.png").write_bytes(adb("exec-out", "screencap", "-p"))
        print("Screenshot only; no accessibility hierarchy claimed")
    elif action == "open":
        adb("reverse", "tcp:8140", "tcp:8140")
        print(adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "exp://127.0.0.1:8140", "host.exp.exponent").decode())
    elif action == "tap":
        kind, value = args
        if kind not in ["text", "content-desc"]:
            raise ValueError("unsupported selector")
        doc, _ = tree()
        matches = []
        for node in doc.iter("node"):
            if node.get(kind) != value:
                continue
            rect = list(map(int, re.findall(r"\d+", node.get("bounds", ""))))
            if len(rect) == 4 and rect[2] > rect[0] and rect[3] > rect[1]:
                matches.append(node)
        if len(matches) != 1:
            raise RuntimeError(f"Expected one visible match, got {len(matches)}")
        bounds = list(map(int, re.findall(r"\d+", matches[0].get("bounds", ""))))
        x1, y1, x2, y2 = bounds
        adb("shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2))
    elif action == "point":
        adb("shell", "input", "tap", *args)
    elif action == "swipe":
        adb("shell", "input", "swipe", *args)
    elif action == "key":
        adb("shell", "input", "keyevent", *args)
    elif action == "text":
        value = args[0]
        if not re.fullmatch(r"[A-Za-z0-9 .,_-]+", value):
            raise ValueError("Synthetic ASCII fixture text only")
        adb("shell", "input", "text", value.replace(" ", "%s"))
    elif action == "font":
        if args[0] not in ["1.0", "2.0"]:
            raise ValueError("bounded font test only")
        adb("shell", "settings", "put", "system", "font_scale", args[0])
        print(adb("shell", "settings", "get", "system", "font_scale").decode().strip())
    else:
        raise ValueError("unknown action")
