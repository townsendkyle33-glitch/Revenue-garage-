"""Watch OpusClip projects; when one completes, import its best clips and schedule them.
Usage: python3 -m engine.autopilot PROJECT_ID=YOUTUBE_ID ...   (runs until all are handled)"""
import sys
import time

from . import db, opus, pipeline


def main(pairs, min_score=80, top=6, require=None):
    con = db.connect()
    todo = dict(p.split("=", 1) for p in pairs)
    done = {r["rights_proof"] for r in con.execute("SELECT rights_proof FROM sources")}
    while todo:
        for pid, yid in list(todo.items()):
            yid, _, given = yid.partition("|")          # optional "|Credit Name (twitch.tv/login)"
            src = yid if yid.startswith("http") else f"https://youtu.be/{yid}"
            credit = given or ("Lacy (twitch.tv/lacy)" if "twitch.tv" in yid and "lacy" in yid.lower() else
                      f"Source: {src.replace('https://', '')}")
            if src in done:
                todo.pop(pid); continue
            try:
                stage = opus.project(pid).get("stage")
            except Exception as e:
                db.log(con, "autopilot", f"Status check failed for {pid}: {e}", level="error"); continue
            if stage == "COMPLETE":
                kw = {} if require is None else {"require": require}
                made = opus.import_project(con, pid, src, credit, approve=False, min_score=min_score, top=top, **kw)
                pipeline.queue(con, within_hours=20)
                todo.pop(pid)
            elif stage and ("FAIL" in stage or "ERROR" in stage or stage == "STALLED"):
                db.log(con, "autopilot", f"OpusClip project {pid} failed ({stage})", level="error")
                todo.pop(pid)
        print(time.strftime("%H:%M:%S"), "waiting on", list(todo), flush=True)
        if todo:
            time.sleep(60)


if __name__ == "__main__":
    main(sys.argv[1:])
