"""OpusClip API client: submit a public video URL, pull back finished vertical clips.
The API key is injected by the session's network proxy, never stored here."""
import json

import requests

from . import copywriter, db

API = "https://api.opus.pro/api"
HDR = {"Authorization": "Bearer proxy-injected", "Content-Type": "application/json"}


def submit(video_url, start=0, end=None, keywords=("GTA 6", "reaction", "hype")):
    pref = {"clipDurations": [[10, 60]], "topicKeywords": list(keywords), "genre": "Auto", "enableAutoHook": True}
    if end:
        pref["range"] = {"startSec": start, "endSec": end}
    r = requests.post(f"{API}/clip-projects", headers=HDR, timeout=60,
                      json={"videoUrl": video_url, "curationPref": pref, "importPref": {"sourceLang": "en"},
                            "renderPref": {"enableWatermark": False}})
    r.raise_for_status()
    return r.json()


def project(pid):
    r = requests.get(f"{API}/clip-projects/{pid}", headers=HDR, timeout=60)
    r.raise_for_status()
    return r.json()


def clips(pid):
    out, page = [], 1
    while True:
        r = requests.get(f"{API}/exportable-clips", headers=HDR, timeout=60,
                         params={"q": "findByProjectId", "projectId": pid, "pageNum": page, "pageSize": 50})
        r.raise_for_status()
        batch = r.json()
        batch = batch.get("data", batch) if isinstance(batch, dict) else batch
        out += batch
        if len(batch) < 50:
            return out
        page += 1


def export_urls(clip_ids, name="wasted-daily-export", wait_sec=600):
    """Render + export clips through a collection. Returns {clip_id: signed URL (valid ~24h)}."""
    import time
    from datetime import datetime
    name = f"{name}-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"     # OpusClip rejects reused names
    r = requests.post(f"{API}/collections", headers=HDR, json={"collectionName": name}, timeout=60)
    r.raise_for_status()
    cid = r.json()["data"]["collectionId"]
    for c in clip_ids:
        requests.post(f"{API}/collection-contents", headers=HDR, timeout=60,
                      json={"collectionId": cid, "contentId": c}).raise_for_status()
    deadline = time.time() + wait_sec
    while True:
        r = requests.post(f"{API}/collections/{cid}/export", headers=HDR, json={}, timeout=120)
        r.raise_for_status()
        lst = r.json()["data"]["contentList"]
        urls = {x["contentId"]: x["uriForExport"] for x in lst if x.get("uriForExport")}
        if len(urls) == len(clip_ids) or time.time() > deadline:
            return urls
        time.sleep(20)


def import_project(con, pid, source_url, credit, rights="repost", category="hype", approve=False,
                   top=6, min_score=70, banned=("leak", "obs ", "stream setup", "audio settings", "setup", "spoiler", "rumor", "insider"),
                   require=("gta", "lucia", "jason", "trailer", "leonida", "vice", "rockstar", "launch", " rp", "roleplay", "cop", "police", "chase", "car", "crash", "npc", "heist", "ragdoll", "los santos", "stream", "xqc")):
    """Register an OpusClip project as a source and its clips as ready-to-post clips."""
    p = project(pid)
    title = (p.get("sourceInfo") or {}).get("title") or p.get("title")
    cur = con.execute(
        "INSERT INTO sources(path,title,creator,creator_handle,rights,rights_proof,duration,status,created_at,ext_project)"
        " VALUES(?,?,?,?,?,?,?,?,?,?)",
        (source_url, title, credit, credit, rights, source_url,
         ((p.get("sourceInfo") or {}).get("durationMs") or 0) / 1000, "processed", db.now(), pid))
    sid = cur.lastrowid
    made = []
    pool = [c for c in clips(pid)
            if (c.get("score") or 0) >= min_score
            and not any(b in (c.get("title") or "").lower() for b in banned)
            and (not require or any(k in ((c.get("title") or "") + " " + (c.get("description") or "")).lower() for k in require))]
    pool = sorted(pool, key=lambda c: -(c.get("score") or 0))[:top]
    urls = export_urls([c["id"] for c in pool], name=f"wd-{pid}") if pool else {}
    for c in pool:
        score = c.get("score") or c.get("viralScore") or 0
        hook = (c.get("title") or "").strip() or "GTA 6 is almost here"
        rng = (c.get("timeRanges") or [[0, c.get("durationMs", 0)]])[0]
        clip = {"category": category, "hook": hook}
        copy = copywriter.write(clip, credit)
        cur = con.execute(
            "INSERT INTO clips(source_id,start,end,score,reasons,category,transcript,hook,path,copy_json,status,created_at,ext_id)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, rng[0] / 1000, rng[1] / 1000, float(score or 0),
             json.dumps(["OpusClip AI pick"] + (c.get("keywords") or [])[:3]), category,
             (c.get("description") or "")[:500], hook, urls.get(c["id"]), json.dumps(copy),
             ("approved" if approve else "awaiting_approval") if urls.get(c["id"]) else "failed", db.now(), c["id"]))
        made.append(cur.lastrowid)
    con.commit()
    db.log(con, "opus", f"Imported {len(made)} clip(s) from OpusClip project {pid}", source=source_url)
    return made


def refresh_urls(con):
    """Signed export URLs last ~24h. Re-export every approved, not-yet-scheduled OpusClip clip."""
    rows = con.execute("SELECT id, ext_id FROM clips WHERE status='approved' AND ext_id IS NOT NULL").fetchall()
    if not rows:
        return 0
    urls = export_urls([r["ext_id"] for r in rows], name="wd-refresh")
    for r in rows:
        if urls.get(r["ext_id"]):
            con.execute("UPDATE clips SET path=? WHERE id=?", (urls[r["ext_id"]], r["id"]))
    con.commit()
    db.log(con, "opus", f"Refreshed export URLs for {len(urls)}/{len(rows)} approved clip(s)")
    return len(urls)


LAUNCH_KEYWORDS = ("GTA 6", "reaction", "funny", "driving", "police chase", "NPC", "graphics", "Vice City", "car", "crash")


def submit_and_record(con, youtube_ids, minutes=20, start_min=0, keywords=None):
    """Submit new videos (skips ones already used). Returns {project_id: youtube_id}."""
    used = {r["rights_proof"] for r in con.execute("SELECT rights_proof FROM sources")}
    out = {}
    for y in youtube_ids:
        if f"https://youtu.be/{y}" in used or y in used:
            continue
        try:
            url = y if y.startswith("http") else f"https://www.youtube.com/watch?v={y}"   # Twitch VOD URLs allowed
            p = submit(url, start_min * 60, (start_min + minutes) * 60,
                       keywords=keywords or ("GTA 6", "reaction", "hype"))
            out[p["projectId"]] = y
            db.log(con, "opus", f"Submitted {y} as {p['projectId']}: {(p.get('sourceInfo') or {}).get('title')}")
        except Exception as e:
            db.log(con, "opus", f"Submit failed for {y}: {e}", level="warn")
    return out


YOUTUBE_ACCOUNT = "6afddc279997edc2b76df934"     # WastedDailyClips (connected in OpusClip)


def schedule_youtube(ext_id, copy, due_utc):
    """Schedule an OpusClip clip as a YouTube Short via OpusClip social posting."""
    project_id, clip_id = ext_id.split(".", 1)
    body = {"projectId": project_id, "clipId": clip_id, "postAccountId": YOUTUBE_ACCOUNT,
            "postDetail": {"title": copy["title"][:100], "mediaType": "video",
                           "custom": {"description": copy["text"], "privacy": "public"}},
            "publishAt": due_utc.replace("Z", ".000Z") if due_utc.endswith("Z") and "." not in due_utc else due_utc}
    import time
    for _ in range(4):
        r = requests.post(f"{API}/publish-schedules", headers=HDR, json=body, timeout=60)
        if r.status_code != 429:
            break
        time.sleep(int((r.json().get("error") or {}).get("retryAfter", 60)) + 5)
    if r.status_code >= 400:
        raise RuntimeError(f"{r.status_code} {r.text[:300]}")
    d = r.json()
    d = d.get("data", d)
    return d.get("scheduleId") or d.get("id") or str(d)[:80]
