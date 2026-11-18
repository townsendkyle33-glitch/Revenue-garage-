"""CLI:  python -m engine <command>

  ingest PATH --rights owned|licensed|submission [--creator NAME --handle @x --title T --proof URL]
  process SOURCE_ID           detect highlights + render vertical clips
  run-inbox                   ingest + process every video in footage/inbox (rights from sidecar .json)
  approve CLIP_ID [...]       mark clips approved for publishing
  queue                       send approved clips to Buffer (respects PUBLISH_MODE)
  metrics                     pull post metrics from Buffer
  money revenue|cost STREAM AMOUNT [--note N] [--verified]
  report                      write daily report + dashboard.json
  status                      check Buffer channels
"""
import argparse
import json
from datetime import date

from . import buffer, config, db, pipeline, report


def main():
    ap = argparse.ArgumentParser(prog="engine")
    sp = ap.add_subparsers(dest="cmd", required=True)
    i = sp.add_parser("ingest"); i.add_argument("path"); i.add_argument("--rights", required=True)
    for a in ("creator", "handle", "title", "proof"):
        i.add_argument(f"--{a}")
    p = sp.add_parser("process"); p.add_argument("source_id", type=int)
    sp.add_parser("run-inbox")
    a = sp.add_parser("approve"); a.add_argument("clip_ids", type=int, nargs="+")
    o = sp.add_parser("opus-import"); o.add_argument("project_id"); o.add_argument("--source", required=True)
    o.add_argument("--credit", required=True); o.add_argument("--category", default="hype"); o.add_argument("--approve", action="store_true")
    q = sp.add_parser("queue"); q.add_argument("--limit", type=int); q.add_argument("--within-hours", type=float)
    sp.add_parser("review")
    h = sp.add_parser("hook"); h.add_argument("clip_id", type=int); h.add_argument("text")
    rj = sp.add_parser("reject"); rj.add_argument("clip_ids", type=int, nargs="+")
    un = sp.add_parser("unschedule"); un.add_argument("clip_id", type=int)
    os_ = sp.add_parser("opus-submit", help="submit YouTube ids to OpusClip and import clips for review")
    os_.add_argument("ids", nargs="+"); os_.add_argument("--start-min", type=int, default=0)
    os_.add_argument("--minutes", type=int, default=20); os_.add_argument("--gameplay", action="store_true",
                     help="GTA 6 gameplay streams: steer clipping to gameplay moments, not story")
    dl = sp.add_parser("daily"); dl.add_argument("--videos", nargs="*", default=[], help="new YouTube ids to clip")
    sp.add_parser("metrics"); sp.add_parser("report"); sp.add_parser("status")
    m = sp.add_parser("money"); m.add_argument("kind", choices=["revenue", "cost"]); m.add_argument("stream")
    m.add_argument("amount", type=float); m.add_argument("--note"); m.add_argument("--verified", action="store_true")
    args = ap.parse_args()
    con = db.connect()

    if args.cmd == "ingest":
        pipeline.ingest(con, args.path, args.rights, args.creator, args.handle, args.title, args.proof)
    elif args.cmd == "process":
        print(pipeline.process(con, args.source_id))
    elif args.cmd == "run-inbox":
        for v in sorted(config.FOOTAGE_INBOX.glob("*.mp4")):
            meta_f = v.with_suffix(".json")
            if not meta_f.exists():
                db.log(con, "ingest", f"Skipped {v.name}: no rights sidecar {meta_f.name}", level="warn")
                continue
            meta = json.loads(meta_f.read_text())
            sid = pipeline.ingest(con, v, meta["rights"], meta.get("creator"), meta.get("handle"),
                                  meta.get("title"), meta.get("proof"))
            pipeline.process(con, sid)
            v.rename(v.with_suffix(".mp4.done"))
    elif args.cmd == "approve":
        pipeline.approve(con, args.clip_ids)
    elif args.cmd == "opus-import":
        from . import opus
        print(opus.import_project(con, args.project_id, args.source, args.credit, category=args.category, approve=args.approve))
    elif args.cmd == "queue":
        print(pipeline.queue(con, limit=args.limit, within_hours=args.within_hours))
    elif args.cmd == "review":
        for r in con.execute("SELECT k.id,k.score,k.status,k.hook,k.transcript,s.title FROM clips k JOIN sources s ON s.id=k.source_id "
                             "WHERE k.status IN ('awaiting_approval','approved') ORDER BY k.status DESC, k.score DESC"):
            print(f"#{r['id']} [{r['status']}] score={r['score']:.0f} | {r['hook']}\n    from: {r['title']}\n    about: {(r['transcript'] or '')[:220]}")
    elif args.cmd == "hook":
        from . import copywriter
        credit = con.execute("SELECT s.creator_handle FROM clips k JOIN sources s ON s.id=k.source_id WHERE k.id=?",
                             (args.clip_id,)).fetchone()[0]
        cat = con.execute("SELECT category FROM clips WHERE id=?", (args.clip_id,)).fetchone()[0]
        con.execute("UPDATE clips SET hook=?, copy_json=? WHERE id=?",
                    (args.text, json.dumps(copywriter.write({"category": cat, "hook": args.text}, credit)), args.clip_id))
        con.commit(); db.log(con, "editor", f"Clip {args.clip_id} hook -> {args.text}")
    elif args.cmd == "reject":
        con.executemany("UPDATE clips SET status='rejected' WHERE id=?", [(i,) for i in args.clip_ids])
        con.commit(); db.log(con, "editor", f"Rejected clips {args.clip_ids}")
    elif args.cmd == "unschedule":
        for r in con.execute("SELECT id, buffer_post_id FROM posts WHERE clip_id=? AND status='scheduled'", (args.clip_id,)).fetchall():
            buffer.gql("mutation($i:DeletePostInput!){deletePost(input:$i){__typename}}", {"i": {"id": r["buffer_post_id"]}})
            con.execute("DELETE FROM posts WHERE id=?", (r["id"],))
        con.execute("UPDATE clips SET status='rejected' WHERE id=?", (args.clip_id,))
        con.commit(); db.log(con, "editor", f"Unscheduled and rejected clip {args.clip_id}")
    elif args.cmd == "opus-submit":
        from . import opus, autopilot
        new = opus.submit_and_record(con, args.ids, minutes=args.minutes, start_min=args.start_min,
                                     keywords=opus.LAUNCH_KEYWORDS if args.gameplay else None)
        if new:
            autopilot.main([f"{p}={y}" for p, y in new.items()])
    elif args.cmd == "daily":
        from . import opus, autopilot
        opus.refresh_urls(con)                       # old approved clips get fresh 24h links
        pipeline.queue(con, within_hours=20)         # fill today's slots with what we already have
        new = opus.submit_and_record(con, args.videos)
        if new:
            autopilot.main([f"{p}={y}" for p, y in new.items()])   # waits, imports, queues
        pipeline.collect_metrics(con)
        print(report.daily_report(con))
        print(report.export_dashboard_files(con))
    elif args.cmd == "metrics":
        pipeline.collect_metrics(con)
    elif args.cmd == "money":
        con.execute("INSERT INTO money(date,kind,stream,amount,note,verified) VALUES(?,?,?,?,?,?)",
                    (date.today().isoformat(), args.kind, args.stream, args.amount, args.note, int(args.verified)))
        con.commit()
    elif args.cmd == "report":
        print(report.daily_report(con))
        print(report.export_dashboard_files(con))
    elif args.cmd == "status":
        for c in buffer.channels():
            print(c)


if __name__ == "__main__":
    main()
