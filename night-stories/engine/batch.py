"""Render + host + schedule every story that has an "air" date and isn't scheduled yet.
python3 -m engine.batch [--only 004,005] [--no-schedule]
Writes progress to batch.log; safe to re-run (skips what's done; cached images are reused)."""
import argparse
import json
import shutil
import traceback
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from . import host, post, story

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "batch.log"
HOSTED = ROOT / "hosted.jsonl"


def log(msg):
    line = f"{datetime.now(timezone.utc).strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with LOG.open("a") as f:
        f.write(line + "\n")


def done_set(path):
    if not path.exists():
        return set()
    return {json.loads(l)["story"] for l in path.read_text().splitlines() if l.strip()}


def playable(mp4):
    import subprocess
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(mp4)],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip()) > 30
    except ValueError:
        return False


def due_utc(air):
    d = date.fromisoformat(air) + timedelta(days=1)          # 9:30 PM ET == 02:30 UTC next day (EST)
    return f"{d.isoformat()}T02:30:00Z"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--no-schedule", action="store_true")
    a = ap.parse_args()
    only = {x.strip() for x in a.only.split(",") if x.strip()}
    scheduled, hosted = done_set(post.LOG), done_set(HOSTED)
    files = sorted(ROOT.glob("stories/[0-9]*.json"))
    for f in files:
        d = json.loads(f.read_text())
        slug = f.stem
        if "air" not in d or slug in scheduled or (only and slug[:3] not in only):
            continue
        if date.fromisoformat(d["air"]) < date.today() - timedelta(days=0):
            log(f"SKIP {slug}: air date {d['air']} already passed")
            continue
        try:
            mp4 = ROOT / "out" / f"{slug}.mp4"
            if slug not in hosted:
                if mp4.exists() and not playable(mp4):
                    log(f"CORRUPT {slug}: removing partial render")
                    mp4.unlink()
                if not mp4.exists():
                    _, secs = story.render(f, "fal")
                    if secs <= 61:
                        log(f"SHORT {slug}: {secs:.1f}s (needs a longer script)")
                        continue
                    log(f"RENDERED {slug} {secs:.1f}s")
                if not playable(mp4):
                    log(f"FAIL {slug}: rendered file is not playable")
                    continue
                url = host.host(mp4)
                with HOSTED.open("a") as h:
                    h.write(json.dumps({"story": slug, "url": url, "air": d["air"]}) + "\n")
                shutil.rmtree(ROOT / "out" / slug, ignore_errors=True)
                log(f"HOSTED {slug}")
            if not a.no_schedule:
                post.schedule(f, due_utc(d["air"]))
                log(f"SCHEDULED {slug} for {d['air']} 9:30 PM ET")
        except Exception as e:
            log(f"FAIL {slug}: {e}")
            traceback.print_exc()


if __name__ == "__main__":
    main()
