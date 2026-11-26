"""Free Twitch path (owner approved Nov 21): download top GTA VI clips at full quality with yt-dlp, no OpusClip
credits. Each clip becomes a source + one clip row awaiting review; a review contact sheet is written so the
operator can LOOK at every clip before approving. After approval, `python3 -m engine house` builds the split layout.

Usage: python3 -m engine.twitchdl [--logins ishowspeed,kaicenat] [--days 3] [--max 20] [--sheet PATH]"""
import argparse
import json
import subprocess
from pathlib import Path

from . import config, copywriter, db, twitch

DL = config.ROOT / "media" / "twitch"
SKIP = ("gyat", "nude", "flash", "shower", "banned", "framegen", "review", "thoughts", "radio", "🔞", "seggs",
        "freaky", "strip", "club", "sus", "edged", "bbl", "steamy", "side girl", "sneaky pic", "copyright")


def download(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["yt-dlp", "-q", "--no-warnings", "-f", "best[height<=1080]", "-o", str(dest), url],
                   check=True, timeout=300)
    return dest


def local_path(url):
    return DL / (url.rstrip("/").split("/")[-1].split("?")[0][:80] + ".mp4")


def fetch(con, logins=None, days=3, limit=20, min_sec=12, min_views=1500, per_user=8):
    used = {r["rights_proof"] for r in con.execute("SELECT rights_proof FROM sources")}
    cands = [v for v in twitch.gta_clips(logins=logins or twitch.STREAMERS, days=days, per_user=per_user, min_views=min_views)
             if v["url"] not in used and int(v["duration"][:-1]) >= min_sec
             and not any(b in v["title"].lower() for b in SKIP)]
    pri = {"ishowspeed": 0, "kaicenat": 0}                        # owner: Speed + Kai first
    cands.sort(key=lambda v: (pri.get(v["login"], 1), -v["views"]))
    made = []
    for v in cands[:limit]:
        try:
            f = download(v["url"], local_path(v["url"]))
        except Exception as e:
            db.log(con, "twitch", f"Download failed {v['url']}: {e}", level="warn")
            continue
        credit = f"{v['name']} (twitch.tv/{v['login']})"
        dur = int(v["duration"][:-1])
        cur = con.execute("INSERT INTO sources(path,title,creator,creator_handle,rights,rights_proof,duration,status,created_at)"
                          " VALUES(?,?,?,?,?,?,?,?,?)", (str(f), v["title"], v["name"], credit, "repost", v["url"], dur,
                                                         "processed", db.now()))
        hook = v["title"]
        cur = con.execute("INSERT INTO clips(source_id,start,end,score,reasons,category,transcript,hook,path,copy_json,status,created_at)"
                          " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                          (cur.lastrowid, 0, dur, float(v["views"]), json.dumps(["twitch top clip", f"views:{v['views']}"]),
                           "streamer", "", hook, str(f), json.dumps(copywriter.write({"category": "streamer", "hook": hook}, credit)),
                           "awaiting_approval", db.now()))
        made.append((cur.lastrowid, v))
    con.commit()
    db.log(con, "twitch", f"Downloaded {len(made)} Twitch clip(s) for review (no OpusClip credits)")
    return made


def sheet(made, path):
    """3 frames per clip (25/50/75%) in one row each, labeled with the clip id, for visual review."""
    from PIL import Image, ImageDraw
    rows = []
    for cid, v in made:
        f = local_path(v["url"]); dur = int(v["duration"][:-1]); frames = []
        for frac in (0.25, 0.5, 0.75):
            tmp = Path(f"/tmp/_sheet_{cid}_{int(frac * 100)}.jpg")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{dur * frac:.1f}", "-i", str(f), "-frames:v", "1",
                            "-vf", "scale=320:-1", str(tmp)], check=False)
            if tmp.exists():
                frames.append(Image.open(tmp).convert("RGB")); tmp.unlink()
        if frames:
            row = Image.new("RGB", (960, 180), "black")
            for i, im in enumerate(frames):
                row.paste(im.resize((320, 180)), (i * 320, 0))
            ImageDraw.Draw(row).text((6, 4), f"#{cid} {v['name']}: {v['title'][:40]}", fill="yellow")
            rows.append(row)
    if not rows:
        return None
    out = Image.new("RGB", (960, 180 * len(rows)))
    for i, r in enumerate(rows):
        out.paste(r, (0, i * 180))
    out.save(path)
    return path


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--logins"); ap.add_argument("--days", type=int, default=3); ap.add_argument("--max", type=int, default=20)
    ap.add_argument("--sheet", default="/tmp/twitch_review.jpg")
    ap.add_argument("--min-views", type=int, default=1500); ap.add_argument("--per-user", type=int, default=8)
    a = ap.parse_args()
    con = db.connect()
    made = fetch(con, a.logins.split(",") if a.logins else None, a.days, a.max, min_views=a.min_views, per_user=a.per_user)
    for cid, v in made:
        print(f"#{cid} {v['name']} | {v['views']} views | {v['duration']} | {v['title']}")
    print("sheet:", sheet(made, a.sheet))
