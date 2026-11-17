"""Growth intelligence + daily executive report + dashboard data export."""
import json
from collections import defaultdict
from datetime import datetime
from statistics import median
from zoneinfo import ZoneInfo

from . import buffer, config, db


def _latest_metrics(con):
    q = """SELECT p.id post_id, p.platform, p.due_at, p.sent_at, p.external_link, c.id clip_id, c.category, c.hook,
                  c.end - c.start AS length, m.views, m.reach, m.likes, m.comments, m.shares, m.saves, m.follows,
                  m.avg_watch_sec, m.hours_after
           FROM posts p JOIN clips c ON c.id=p.clip_id
           LEFT JOIN metrics m ON m.id = (SELECT id FROM metrics WHERE post_id=p.id ORDER BY read_at DESC LIMIT 1)
           WHERE p.status='sent'"""
    return [dict(r) for r in con.execute(q)]


def recommendations(rows):
    recs = []
    scored = [r for r in rows if r["views"] is not None]
    if len(scored) < 5:
        return ["Not enough published posts with metrics yet (need 5+). Keep posting at the daily mix; "
                "no conclusions before 24h reads."]
    med = median(r["views"] for r in scored)
    by_cat = defaultdict(list)
    for r in scored:
        by_cat[r["category"]].append(r["views"])
    cat_med = {c: median(v) for c, v in by_cat.items() if len(v) >= 2}
    if cat_med:
        best = max(cat_med, key=cat_med.get)
        worst = min(cat_med, key=cat_med.get)
        recs.append(f"Double down on '{best}' (median {cat_med[best]:.0f} views vs overall {med:.0f}).")
        if worst != best and cat_med[worst] < 0.6 * med:
            recs.append(f"Cut or rework '{worst}' (median {cat_med[worst]:.0f} views).")
    retention = [(r["avg_watch_sec"] / r["length"], r) for r in scored if r["avg_watch_sec"] and r["length"]]
    if len(retention) >= 5:
        short = [x for x, r in retention if r["length"] <= 15]
        long = [x for x, r in retention if r["length"] > 15]
        if short and long:
            recs.append(f"Retention: ≤15s clips keep {median(short):.0%} watched vs {median(long):.0%} for longer clips. "
                        + ("Trim harder." if median(short) > median(long) else "Longer setups are working."))
    by_hour = defaultdict(list)
    for r in scored:
        if r["sent_at"]:
            h = datetime.fromisoformat(r["sent_at"].replace("Z", "+00:00")).astimezone(ZoneInfo(config.TIMEZONE)).hour
            by_hour[h].append(r["views"])
    if len(by_hour) >= 3:
        h = max(by_hour, key=lambda k: median(by_hour[k]))
        recs.append(f"Best posting hour so far: {h}:00 ET. Test moving a weak slot there.")
    return recs


def money(con):
    month = datetime.now(ZoneInfo(config.TIMEZONE)).strftime("%Y-%m")
    rows = [dict(r) for r in con.execute("SELECT * FROM money WHERE substr(date,1,7)=?", (month,))]
    rev = defaultdict(float)
    cost = 0.0
    for r in rows:
        if r["kind"] == "revenue" and r["verified"]:
            rev[r["stream"]] += r["amount"]
        elif r["kind"] == "cost":
            cost += r["amount"]
    total = sum(rev.values())
    return {"month": month, "revenue_by_stream": dict(rev), "revenue": total, "costs": cost,
            "net": total - cost, "target": config.MONTHLY_TARGET_USD, "targets": config.REVENUE_TARGETS,
            "progress": total / config.MONTHLY_TARGET_USD}


def export(con, check_channels=True):
    rows = _latest_metrics(con)
    clip_counts = {r["status"]: r["n"] for r in con.execute("SELECT status, COUNT(*) n FROM clips GROUP BY status")}
    sources = [dict(r) for r in con.execute("SELECT id,title,creator,rights,status,duration,created_at FROM sources ORDER BY id DESC LIMIT 20")]
    clips = [dict(r) for r in con.execute(
        "SELECT id,source_id,start,end,score,reasons,category,hook,status,created_at FROM clips ORDER BY id DESC LIMIT 50")]
    events = [dict(r) for r in con.execute("SELECT at,level,agent,message FROM events ORDER BY id DESC LIMIT 40")]
    errors = [e for e in events if e["level"] == "error"]
    chans = []
    if check_channels:
        try:
            chans = buffer.channels()
        except Exception as e:
            errors.insert(0, {"at": db.now(), "level": "error", "agent": "buffer", "message": f"Channel check failed: {e}"})
    top = sorted([r for r in rows if r["views"] is not None], key=lambda r: -r["views"])[:10]
    data = {
        "generated_at": db.now(),
        "publish_mode": config.PUBLISH_MODE,
        "media_hosting": bool(config.PUBLIC_MEDIA_BASE_URL),
        "overview": {
            "total_views": sum(r["views"] or 0 for r in rows),
            "published": len(rows),
            "followers_gained": sum(r["follows"] or 0 for r in rows),
        },
        "channels": chans,
        "factory": {"sources": sources, "clips": clips, "counts": clip_counts},
        "growth": {"top": top, "recommendations": recommendations(rows)},
        "money": money(con),
        "automation": {"events": events, "errors": errors[:15]},
    }
    out = config.DATA / "dashboard.json"
    out.write_text(json.dumps(data, indent=1, default=str))
    return data


def daily_report(con):
    d = export(con)
    today = datetime.now(ZoneInfo(config.TIMEZONE)).strftime("%Y-%m-%d")
    m = d["money"]
    lines = [f"# Daily executive report — {today}", "",
             f"- Publish mode: **{d['publish_mode']}** · media hosting: **{'ready' if d['media_hosting'] else 'NOT SET'}**",
             f"- Posts published (all time): {d['overview']['published']} · views: {d['overview']['total_views']:.0f}",
             f"- Clips by status: {d['factory']['counts'] or 'none yet'}",
             f"- Revenue this month (verified): ${m['revenue']:.2f} · costs ${m['costs']:.2f} · net ${m['net']:.2f} "
             f"· {m['progress']:.1%} of ${m['target']:,}",
             "", "## Top clips"]
    lines += [f"- {r['hook']} ({r['platform']}, {r['views']:.0f} views)" for r in d["growth"]["top"][:3]] or ["- none yet"]
    lines += ["", "## Recommendations"] + [f"- {r}" for r in d["growth"]["recommendations"]]
    lines += ["", "## Errors"] + ([f"- {e['agent']}: {e['message']}" for e in d["automation"]["errors"][:5]] or ["- none"])
    lines += ["", "## Blockers"] + [f"- {b}" for b in blockers()]
    config.REPORTS.mkdir(exist_ok=True)
    path = config.REPORTS / f"{today}.md"
    path.write_text("\n".join(lines) + "\n")
    return path


def export_dashboard_files(con):
    """Write the flat row files the Wasted Daily HQ dashboard reads (data/dash/*.json)."""
    d = export(con)
    out = config.DATA / "dash"
    out.mkdir(parents=True, exist_ok=True)
    m = d["money"]
    stage_order = ["incoming", "detected", "awaiting_approval", "approved", "scheduled", "published", "failed"]
    counts = dict(d["factory"]["counts"])
    counts["incoming"] = sum(1 for s in d["factory"]["sources"] if s["status"] == "new")
    counts["published"] = d["overview"]["published"]
    files = {
        "kpis": [
            {"metric": "views", "value": d["overview"]["total_views"]},
            {"metric": "published", "value": d["overview"]["published"]},
            {"metric": "followers_gained", "value": d["overview"]["followers_gained"]},
            {"metric": "revenue_month", "value": m["revenue"]},
            {"metric": "costs_month", "value": m["costs"]},
            {"metric": "net_month", "value": m["net"]},
            {"metric": "rev_platform", "value": m["revenue_by_stream"].get("platform", 0)},
            {"metric": "rev_sponsorship", "value": m["revenue_by_stream"].get("sponsorship", 0)},
            {"metric": "rev_affiliate", "value": m["revenue_by_stream"].get("affiliate", 0)},
            {"metric": "rev_services", "value": m["revenue_by_stream"].get("services", 0)},
        ],
        "stages": [{"stage": s, "clips": counts.get(s, 0)} for s in stage_order],
        "clips": [{"clip": c["id"], "hook": c["hook"], "category": c["category"], "score": c["score"],
                   "length_sec": round(c["end"] - c["start"], 1), "why": ", ".join(json.loads(c["reasons"] or "[]")),
                   "status": c["status"]} for c in d["factory"]["clips"]],
        "channels": [{"platform": c["service"], "handle": c["name"],
                      "state": "disconnected" if c["isDisconnected"] else ("locked" if c["isLocked"] else "connected")}
                     for c in d["channels"]]
                    + [{"platform": p, "handle": "—", "state": "not connected"} for p in ("youtube", "facebook", "threads")],
        "activity": [{"at": e["at"], "kind": e["level"], "agent": e["agent"], "message": e["message"]}
                     for e in d["automation"]["events"]]
                    + [{"at": d["generated_at"], "kind": "recommendation", "agent": "growth", "message": r}
                       for r in d["growth"]["recommendations"]]
                    + [{"at": d["generated_at"], "kind": "blocker", "agent": "setup", "message": b} for b in blockers()],
    }
    for name, rows in files.items():
        (out / f"{name}.json").write_text(json.dumps(rows, indent=1, default=str))
    return out


def blockers():
    b = []
    if not config.PUBLIC_MEDIA_BASE_URL:
        b.append("No public video hosting yet, so Buffer can't fetch clips. Needs a storage choice (see ARCHITECTURE.md).")
    if config.PUBLISH_MODE != "auto":
        b.append(f"Publishing is in '{config.PUBLISH_MODE}' mode: clips go to Buffer as drafts until you authorize auto-posting.")
    b.append("No owned or licensed GTA footage yet. Record gameplay or sign up creators before real clips can be made.")
    b.append("YouTube, Facebook and Threads not connected (Buffer free plan allows 3 channels).")
    return b
