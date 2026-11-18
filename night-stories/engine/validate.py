"""Check story scripts: python3 -m engine.validate [files...]  (default: all stories/*.json)"""
import json
import re
import sys
from datetime import date
from pathlib import Path

BANNED = re.compile(r"\b(blood|bloody|gore|corpse|dead body|suicide|kill himself|kill herself|naked|sex)\b", re.I)


def check(p):
    errs = []
    try:
        d = json.loads(Path(p).read_text())
    except Exception as e:
        return [f"bad json: {e}"]
    for k in ("series", "part", "title", "style", "caption", "scenes"):
        if k not in d:
            errs.append(f"missing {k}")
    if errs:
        return errs
    n = int(d["part"])
    if "air" in d:
        try:
            date.fromisoformat(d["air"])
        except ValueError:
            errs.append("bad air date")
    elif n > 3 or "harlow" not in p:
        errs.append("missing air")
    sc = d["scenes"]
    if not 8 <= len(sc) <= 11:
        errs.append(f"{len(sc)} scenes")
    words = sum(len(s.get("narration", "").split()) for s in sc)
    if not 165 <= words <= 240:
        errs.append(f"{words} words")
    if n > 1 and not sc[0]["narration"].lower().startswith("last time"):
        errs.append("part > 1 must open with 'Last time:'")
    if not d["caption"].startswith(("Part ", "Final part.")):
        errs.append("caption must start with 'Part N.' or 'Final part.'")
    if "Original fiction." not in d["caption"] or "#scarystories" not in d["caption"]:
        errs.append("caption missing 'Original fiction.' or hashtags")
    if len(d["title"]) > 45:
        errs.append("title too long")
    if "no text" not in d["style"]:
        errs.append("style must include 'no text'")
    for i, s in enumerate(sc):
        if not s.get("image") or not s.get("narration"):
            errs.append(f"scene {i} incomplete")
        if BANNED.search(s.get("narration", "") + " " + s.get("image", "")):
            errs.append(f"scene {i} banned word")
    return errs


if __name__ == "__main__":
    files = sys.argv[1:] or sorted(str(p) for p in Path("stories").glob("[0-9]*.json"))
    bad = 0
    for f in files:
        e = check(f)
        if e:
            bad += 1
        print(("OK  " if not e else "BAD ") + f + ("" if not e else "  -> " + "; ".join(e)))
    sys.exit(1 if bad else 0)
