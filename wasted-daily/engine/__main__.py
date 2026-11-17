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
    sp.add_parser("queue"); sp.add_parser("metrics"); sp.add_parser("report"); sp.add_parser("status")
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
    elif args.cmd == "queue":
        print(pipeline.queue(con))
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
