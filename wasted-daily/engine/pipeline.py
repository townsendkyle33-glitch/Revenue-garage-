"""Content pipeline agents: ingest -> detect -> render -> copy -> queue."""
import json
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from . import buffer, config, copywriter, db, detect, media, render, transcribe


def ingest(con, path, rights, creator=None, handle=None, title=None, proof=None):
    if rights not in config.ALLOWED_RIGHTS:
        raise SystemExit(f"Refused: rights must be one of {sorted(config.ALLOWED_RIGHTS)}. "
                         "We only process footage we own, license, or that creators submit with permission.")
    if rights != "owned" and not proof:
        raise SystemExit("Refused: licensed/submission footage needs --proof (link or file of the permission).")
    src = Path(path).resolve()
    dest = config.RAW / src.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src != dest:
        shutil.copy2(src, dest)
    cur = con.execute(
        "INSERT INTO sources(path,title,creator,creator_handle,rights,rights_proof,duration,created_at)"
        " VALUES(?,?,?,?,?,?,?,?)",
        (str(dest), title or src.stem, creator, handle, rights, proof, media.duration(dest), db.now()))
    con.commit()
    db.log(con, "ingest", f"Source #{cur.lastrowid} added ({rights}): {src.name}")
    return cur.lastrowid


def process(con, source_id):
    s = con.execute("SELECT * FROM sources WHERE id=?", (source_id,)).fetchone()
    if s["rights"] not in config.ALLOWED_RIGHTS:
        raise SystemExit("Rights gate: source not cleared")
    db.log(con, "detect", f"Transcribing + scoring source #{source_id}")
    words = transcribe.words(s["path"])
    picks = detect.pick(s["path"], words)
    db.log(con, "detect", f"Found {len(picks)} highlight(s) in source #{source_id}",
           picks=[(p["start"], p["end"], p["score"]) for p in picks])
    made = []
    for i, p in enumerate(picks, 1):
        text = transcribe.text_between(words, p["start"], p["end"])
        cat = detect.categorize(text, s["title"] or "")
        hook = copywriter.hook_for(cat, text, f"{source_id}-{i}")
        out = config.EDITS / f"s{source_id:03d}_c{i:02d}_{cat}.mp4"
        try:
            media_path = render.render(
                s["path"], out, p["start"], p["end"], hook, words, peak=p["peak"])
            status = "awaiting_approval"
        except Exception as e:  # keep going; failures are logged for the dashboard
            db.log(con, "render", f"Render failed for source #{source_id} clip {i}: {e}", level="error")
            media_path, status = None, "failed"
        clip = {"category": cat, "hook": hook}
        copy = copywriter.write(clip, s["creator_handle"])
        cur = con.execute(
            "INSERT INTO clips(source_id,start,end,score,reasons,category,transcript,hook,path,copy_json,status,created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (source_id, p["start"], p["end"], p["score"], json.dumps(p["reasons"]), cat, text, hook,
             str(media_path) if media_path else None, json.dumps(copy), status, db.now()))
        made.append(cur.lastrowid)
    con.execute("UPDATE sources SET status='processed' WHERE id=?", (source_id,))
    con.commit()
    db.log(con, "render", f"Rendered {len(made)} clip(s) from source #{source_id}")
    return made


def next_slots(con, n):
    tz = ZoneInfo(config.TIMEZONE)
    taken = {r["due_at"].replace(".000Z", "Z")[:16] for r in con.execute(
        "SELECT due_at FROM posts WHERE due_at IS NOT NULL AND status NOT IN ('failed','removed','error')")}
    out, day = [], datetime.now(tz).date()
    while len(out) < n:
        for hhmm in config.DAILY_SLOTS_ET:
            h, m = map(int, hhmm.split(":"))
            t = datetime(day.year, day.month, day.day, h, m, tzinfo=tz)
            iso = t.astimezone(ZoneInfo("UTC")).isoformat().replace("+00:00", "Z")
            if t > datetime.now(tz) + timedelta(minutes=20) and iso[:16] not in taken:
                out.append(iso)
                taken.add(iso[:16])
                if len(out) == n:
                    break
        day += timedelta(days=1)
    return out


def approve(con, clip_ids):
    for cid in clip_ids:
        con.execute("UPDATE clips SET status='approved' WHERE id=? AND status='awaiting_approval'", (cid,))
    con.commit()
    db.log(con, "approval", f"Approved clips {clip_ids}")


def queue(con, platforms=("x", "instagram", "tiktok"), limit=None, within_hours=None):
    """Send approved clips to Buffer, obeying PUBLISH_MODE."""
    if config.PUBLISH_MODE == "off":
        db.log(con, "publish", "PUBLISH_MODE=off; nothing sent", level="warn")
        return []
    clips = [c for c in con.execute("SELECT * FROM clips WHERE status='approved' ORDER BY (category='gta6') DESC, score DESC")
             if (c["path"] or "").startswith("http") or config.PUBLIC_MEDIA_BASE_URL]
    if not clips:
        db.log(con, "publish", "Nothing to queue (no approved clips with a public video URL)", level="warn")
        return []
    clips = clips[:limit] if limit else clips
    slots = next_slots(con, len(clips))
    if within_hours:   # signed media URLs expire; only use slots inside the window
        cutoff = datetime.now(ZoneInfo("UTC")) + timedelta(hours=within_hours)
        keep = [(c, s) for c, s in zip(clips, slots) if datetime.fromisoformat(s.replace("Z", "+00:00")) <= cutoff]
        clips, slots = [c for c, _ in keep], [s for _, s in keep]
    done = []
    for clip, due in zip(clips, slots):
        copy = json.loads(clip["copy_json"])
        url = clip["path"] if clip["path"].startswith("http") else \
            f"{config.PUBLIC_MEDIA_BASE_URL.rstrip('/')}/{Path(clip['path']).name}"
        for plat in platforms:
            if plat not in config.CHANNELS:
                continue
            try:
                post = buffer.create_post(plat, copy[plat], url, due_at=due,
                                          draft=(config.PUBLISH_MODE != "auto"))
                con.execute("INSERT INTO posts(clip_id,platform,buffer_post_id,status,due_at,created_at)"
                            " VALUES(?,?,?,?,?,?)", (clip["id"], plat, post["id"], post["status"], due, db.now()))
                done.append(post["id"])
            except Exception as e:
                con.execute("INSERT INTO posts(clip_id,platform,status,due_at,error,created_at) VALUES(?,?,?,?,?,?)",
                            (clip["id"], plat, "failed", due, str(e)[:500], db.now()))
                db.log(con, "publish", f"Buffer post failed for clip {clip['id']} on {plat}: {e}", level="error")
        if clip["ext_id"] and config.PUBLISH_MODE == "auto":     # YouTube Shorts via OpusClip
            try:
                from . import opus
                sid = opus.schedule_youtube(clip["ext_id"], copy["youtube"], due)
                con.execute("INSERT INTO posts(clip_id,platform,buffer_post_id,status,due_at,created_at)"
                            " VALUES(?,?,?,?,?,?)", (clip["id"], "youtube", f"opus:{sid}", "scheduled", due, db.now()))
                done.append(sid)
            except Exception as e:
                con.execute("INSERT INTO posts(clip_id,platform,status,due_at,error,created_at) VALUES(?,?,?,?,?,?)",
                            (clip["id"], "youtube", "failed", due, str(e)[:500], db.now()))
                db.log(con, "publish", f"YouTube (OpusClip) post failed for clip {clip['id']}: {e}", level="error")
        con.execute("UPDATE clips SET status='scheduled' WHERE id=?", (clip["id"],))
    con.commit()
    db.log(con, "publish", f"Queued {len(done)} post(s) in mode={config.PUBLISH_MODE}")
    return done


def collect_metrics(con):
    try:
        nodes = buffer.sent_posts_with_metrics()
    except Exception as e:
        db.log(con, "metrics", f"Metrics pull failed: {e}", level="error")
        return 0
    n = 0
    for node in nodes:
        row = con.execute("SELECT id, sent_at FROM posts WHERE buffer_post_id=?", (node["id"],)).fetchone()
        if not row:
            continue
        m = {x["type"]: x["value"] for x in node.get("metrics") or []}
        sent = node.get("sentAt")
        con.execute("UPDATE posts SET status='sent', sent_at=?, external_link=? WHERE id=?",
                    (sent, node.get("externalLink"), row["id"]))
        hours = None
        if sent:
            hours = (datetime.now(ZoneInfo("UTC")) - datetime.fromisoformat(sent.replace("Z", "+00:00"))).total_seconds() / 3600
        con.execute("INSERT INTO metrics(post_id,read_at,hours_after,views,reach,likes,comments,shares,saves,follows,"
                    "avg_watch_sec,raw) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    (row["id"], db.now(), hours, m.get("views"), m.get("reach"), m.get("likes"), m.get("comments"),
                     m.get("shares"), m.get("saves"), m.get("follows"), m.get("averageTimeWatched"), json.dumps(m)))
        n += 1
    con.commit()
    db.log(con, "metrics", f"Pulled metrics for {n} post(s)")
    return n
