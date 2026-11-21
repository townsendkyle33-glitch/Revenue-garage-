"""Re-render approved clips in the house split format (facecam top / gameplay bottom), host them, and point the
clip at the hosted file. Clips with no detectable facecam are rejected: they are not our format.

Usage: python3 -m engine house [CLIP_ID ...]     (default: every approved clip not yet in house format)"""
import json
import sys
import time
from pathlib import Path

import requests

from . import config, db, opus, splitcam

FIT_PREF = opus.FIT_PREF
OUT = config.ROOT / "media" / "house"


def _submit(url, start=None, end=None):
    pref = {"clipDurations": [[8, 90]]}
    if start is not None:
        pref["range"] = {"startSec": int(start), "endSec": int(end) + 1}
    for _ in range(4):
        r = requests.post(f"{opus.API}/clip-projects", headers=opus.HDR, timeout=60,
                          json={"videoUrl": url, "curationPref": pref, "importPref": {"sourceLang": "en"},
                                "renderPref": FIT_PREF})
        if r.status_code != 429:
            break
        time.sleep(int((r.json().get("error") or {}).get("retryAfter", 30)) + 5)
    r.raise_for_status()
    return r.json()["id"]


def run(con, clip_ids=None, wait=1800):
    import importlib.util                     # night-stories/engine/host.py pushes to the public media repo
    spec = importlib.util.spec_from_file_location("ns_host", config.ROOT.parent / "night-stories" / "engine" / "host.py")
    mhost = importlib.util.module_from_spec(spec); spec.loader.exec_module(mhost)
    if not clip_ids:
        clip_ids = [r[0] for r in con.execute(
            "SELECT id FROM clips WHERE status='approved' AND (path NOT LIKE '%night-stories-media%' OR path IS NULL)")]
    jobs = {}
    for cid in clip_ids:
        k = con.execute("SELECT k.*, s.rights_proof src FROM clips k JOIN sources s ON s.id=k.source_id WHERE k.id=?",
                        (cid,)).fetchone()
        src = k["src"]
        if k["ext_id"]:                         # already rendered full-frame by OpusClip? reuse it, no new credits
            pid0 = k["ext_id"].split(".")[0]
            if (opus.project(pid0).get("renderPref") or {}).get("fitLayoutCropRatio") == "16:9":
                jobs[pid0 + "#" + k["ext_id"]] = k
                continue
        whole = "/clip/" in src or "/shorts/" in src or (k["start"] or 0) < 1 and (k["end"] or 0) < 70
        try:
            jobs[_submit(src) if whole else _submit(src, max(0, k["start"] - 1), k["end"] + 1)] = k
        except Exception as e:
            db.log(con, "house", f"Fit submit failed for clip {cid}: {e}", level="warn")
    done, deadline = [], time.time() + wait
    while jobs and time.time() < deadline:
        for key, k in list(jobs.items()):
            pid, _, want = key.partition("#")
            st = opus.project(pid).get("stage")
            if st == "COMPLETE":
                jobs.pop(key)
                cl = [c for c in opus.clips(pid) if not want or c["id"] == want]
                cl = sorted(cl, key=lambda c: -(c.get("durationMs") or 0))
                if not cl:
                    continue
                raw = OUT / f"raw_{k['id']}.mp4"; raw.parent.mkdir(parents=True, exist_ok=True)
                raw.write_bytes(requests.get(cl[0]["uriForPreview"], timeout=120).content)
                out = splitcam.build(raw, OUT / f"wd_{k['id']}.mp4", k["hook"])
                raw.unlink(missing_ok=True)
                if not out:
                    con.execute("UPDATE clips SET status='rejected' WHERE id=?", (k["id"],))
                    db.log(con, "house", f"Clip {k['id']} rejected: no stable facecam for the split layout")
                    continue
                url = mhost.host(out, subdir="wd")
                reasons = json.loads(k["reasons"] or "[]") + [f"house:{cl[0]['id']}"]
                con.execute("UPDATE clips SET path=?, ext_id=NULL, reasons=? WHERE id=?", (url, json.dumps(reasons), k["id"]))
                con.commit()
                done.append(k["id"])
                print("HOUSE", k["id"], url, flush=True)
            elif st and ("FAIL" in st or "ERROR" in st or st == "STALLED"):
                jobs.pop(key)
                db.log(con, "house", f"Fit render failed for clip {k['id']} ({st})", level="warn")
        if jobs:
            time.sleep(30)
    con.commit()
    db.log(con, "house", f"House-format renders: {done}")
    return done


if __name__ == "__main__":
    print(run(db.connect(), [int(a) for a in sys.argv[1:]]))
