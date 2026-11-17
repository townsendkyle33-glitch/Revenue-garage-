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
                      json={"videoUrl": video_url, "curationPref": pref, "importPref": {"sourceLang": "en"}})
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
                   require=("gta", "lucia", "jason", "trailer", "leonida", "vice", "rockstar", "launch")):
    """Register an OpusClip project as a source and its clips as ready-to-post clips."""
    p = project(pid)
    title = (p.get("sourceInfo") or {}).get("title") or p.get("title")
    cur = con.execute(
        "INSERT INTO sources(path,title,creator,creator_handle,rights,rights_proof,duration,status,created_at)"
        " VALUES(?,?,?,?,?,?,?,?,?)",
        (source_url, title, credit, credit, rights, source_url,
         ((p.get("sourceInfo") or {}).get("durationMs") or 0) / 1000, "processed", db.now()))
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
            "INSERT INTO clips(source_id,start,end,score,reasons,category,transcript,hook,path,copy_json,status,created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, rng[0] / 1000, rng[1] / 1000, float(score or 0),
             json.dumps(["OpusClip AI pick"] + (c.get("keywords") or [])[:3]), category,
             (c.get("description") or "")[:500], hook, urls.get(c["id"]), json.dumps(copy),
             ("approved" if approve else "awaiting_approval") if urls.get(c["id"]) else "failed", db.now()))
        made.append(cur.lastrowid)
    con.commit()
    db.log(con, "opus", f"Imported {len(made)} clip(s) from OpusClip project {pid}", source=source_url)
    return made
