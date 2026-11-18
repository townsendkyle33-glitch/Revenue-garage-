"""Build the Season 1 reader page (HTML) from stories/*.json + posted.jsonl."""
import html
import json
import re
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = "https://raw.githubusercontent.com/townsendkyle33-glitch/night-stories-media/main/videos/"


def calendar_premises():
    out = {}
    txt = (ROOT / "stories" / "calendar.md").read_text()
    for m in re.finditer(r"^## (?:S\d+ )?(.+?) — .*?\n(.+?)\n", txt, re.M):
        out[m.group(1).strip()] = m.group(2).strip()
    return out


def main(out_path):
    posted = {}
    for f in ("posted.jsonl",):
        p = ROOT / f
        if p.exists():
            for l in p.read_text().splitlines():
                if l.strip():
                    r = json.loads(l)
                    posted[r["story"]] = r
    prem = calendar_premises()
    prem["Harlow Creek"] = ("Nobody in Harlow Creek locks their doors. In 1987 the Mercers did, and vanished at 3:12 AM. "
                            "Thirty years later, podcaster Jenna Cole comes looking.")
    series, order = {}, []
    for f in sorted(ROOT.glob("stories/[0-9]*.json")):
        d = json.loads(f.read_text())
        s = d.get("series", "Harlow Creek")
        if s not in series:
            series[s] = []
            order.append(s)
        d["slug"] = f.stem
        if not d.get("air"):
            d["air"] = {"001-harlow-creek": "2026-11-17", "002-harlow-creek-the-tape": "2026-11-18",
                        "003-harlow-creek-the-pact": "2026-11-19"}.get(f.stem, "")
        series[s].append(d)

    today = date.today()
    total = sum(len(v) for v in series.values())
    sched = sum(1 for v in series.values() for d in v if d["slug"] in posted)

    def fmt(a):
        return datetime.strptime(a, "%Y-%m-%d").strftime("%a %b %-d") if a else ""

    blocks = []
    for i, s in enumerate(order, 1):
        eps = sorted(series[s], key=lambda d: int(d["part"]))
        rng = f"{fmt(eps[0]['air'])} – {fmt(eps[-1]['air'])}"
        items = []
        for d in eps:
            aired = d["air"] and date.fromisoformat(d["air"]) < today
            if d["slug"] in posted:
                state, cls = ("Posted" if aired else "Scheduled"), "ok"
            else:
                state, cls = "Rendering", "wait"
            paras = "".join(f"<p>{html.escape(sc['narration'])}</p>" for sc in d["scenes"])
            words = sum(len(sc["narration"].split()) for sc in d["scenes"])
            link = (f'<a class="watch" href="{RAW}{d["slug"]}.mp4" target="_blank" rel="noopener">Watch video</a>'
                    if d["slug"] in posted else "")
            final = " · Finale" if d["caption"].startswith("Final part") else ""
            items.append(f"""
<details class="ep" id="ep-{d['slug'][:3]}">
  <summary>
    <span class="pn">Part {d['part']}</span>
    <span class="et">{html.escape(d['title'])}<em>{final}</em></span>
    <span class="ad">{fmt(d['air'])}</span>
    <span class="st {cls}">{state}</span>
  </summary>
  <div class="body">
    <div class="script">{paras}</div>
    <div class="meta"><span>{words} words · 9:30 PM ET</span>{link}</div>
    <div class="cap"><span class="lbl">TikTok caption</span><pre>{html.escape(d['caption'])}</pre></div>
  </div>
</details>""")
        blocks.append(f"""
<section class="series" id="s{i}">
  <header class="tab"><span class="no">File {i:02d}</span><span class="dates">{rng}</span></header>
  <h2>{html.escape(s)}</h2>
  <p class="premise">{html.escape(prem.get(s, ''))}</p>
  {''.join(items)}
</section>""")

    idx = "".join(f'<a href="#s{i}"><span>{i:02d}</span>{html.escape(s)}</a>' for i, s in enumerate(order, 1))
    page = f"""<title>Midnight Files Season 1</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Special+Elite&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: a stack of case files on a night desk; each series is a manila-tabbed folder, episodes open like case notes. */
:root {{
  --night: #0b0f17; --desk: #121826; --paper: #e9e1cf; --paper-dim: #b9b09c; --manila: #8a6a3c;
  --ink: #e6e2d8; --muted: #9aa3b5; --line: #263044; --red: #c4392f; --ok: #6fbf8e; --wait: #d9a441;
  --f-type: "Special Elite", "Courier New", monospace;
  --f-body: "Source Serif 4", Georgia, serif;
  --f-mono: "IBM Plex Mono", ui-monospace, monospace;
  color-scheme: dark;
}}
body {{ background: var(--night); color: var(--ink); font-family: var(--f-body); font-size: 16px; line-height: 1.6; }}
.wrap {{ max-width: 780px; margin: 0 auto; padding-block: 28px 64px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }}
.hero {{ display: grid; gap: 10px; padding-bottom: 22px; border-bottom: 1px dashed var(--line); }}
.hero .kicker {{ font-family: var(--f-mono); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: var(--red); }}
.hero h1 {{ font-family: var(--f-type); font-weight: 400; font-size: clamp(34px, 7vw, 56px); line-height: 1.05; margin: 0; color: var(--paper); text-wrap: balance; }}
.hero p {{ margin: 0; color: var(--muted); max-width: 62ch; }}
.stats {{ display: flex; flex-wrap: wrap; gap: 8px 20px; font-family: var(--f-mono); font-size: 13px; color: var(--paper-dim); }}
.stats b {{ color: var(--paper); font-weight: 500; font-variant-numeric: tabular-nums; }}
nav.index {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 6px 14px; padding-block: 18px; border-bottom: 1px dashed var(--line); }}
nav.index a {{ color: var(--ink); text-decoration: none; font-size: 14px; display: flex; gap: 8px; align-items: baseline; min-width: 0; }}
nav.index a span {{ font-family: var(--f-mono); font-size: 11px; color: var(--manila); }}
nav.index a:hover, nav.index a:focus-visible {{ color: var(--paper); text-decoration: underline; }}
.series {{ margin-top: 34px; background: var(--desk); border: 1px solid var(--line); border-radius: 4px 10px 10px 10px; padding: 0 18px 14px; position: relative; }}
.tab {{ display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 0 -18px; padding: 8px 18px;
  background: var(--manila); color: #1b1408; font-family: var(--f-mono); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; border-radius: 4px 10px 0 0; }}
.series h2 {{ font-family: var(--f-type); font-weight: 400; font-size: 28px; margin: 16px 0 4px; color: var(--paper); }}
.premise {{ margin: 0 0 12px; color: var(--muted); font-size: 15px; }}
details.ep {{ border-top: 1px solid var(--line); }}
details.ep summary {{ list-style: none; cursor: pointer; display: grid; grid-template-columns: 58px 1fr auto auto; gap: 10px; align-items: baseline; padding: 11px 0; }}
details.ep summary::-webkit-details-marker {{ display: none; }}
details.ep summary:focus-visible {{ outline: 2px solid var(--manila); outline-offset: 2px; }}
.pn {{ font-family: var(--f-mono); font-size: 12px; color: var(--red); }}
.et {{ font-weight: 600; min-width: 0; }}
.et em {{ font-style: normal; color: var(--manila); font-weight: 400; font-size: 13px; }}
.ad {{ font-family: var(--f-mono); font-size: 12px; color: var(--paper-dim); white-space: nowrap; font-variant-numeric: tabular-nums; }}
.st {{ font-family: var(--f-mono); font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid; white-space: nowrap; }}
.st.ok {{ color: var(--ok); }} .st.wait {{ color: var(--wait); }}
details[open] summary .et {{ color: var(--paper); }}
.body {{ padding: 2px 0 16px; display: grid; gap: 14px; }}
.script {{ background: var(--paper); color: #1d1a14; padding: 16px 18px; border-radius: 3px; box-shadow: 0 1px 0 rgba(0,0,0,.4); }}
.script p {{ margin: 0 0 .7em; max-width: 64ch; }} .script p:last-child {{ margin: 0; font-weight: 600; }}
.meta {{ display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; font-family: var(--f-mono); font-size: 12px; color: var(--muted); }}
.watch {{ color: var(--night); background: var(--paper); text-decoration: none; padding: 6px 12px; border-radius: 3px; font-weight: 500; }}
.watch:hover, .watch:focus-visible {{ background: #fff; }}
.cap .lbl {{ display: block; font-family: var(--f-mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--manila); margin-bottom: 4px; }}
.cap pre {{ margin: 0; white-space: pre-wrap; font-family: var(--f-mono); font-size: 12.5px; color: var(--paper-dim); }}
footer {{ margin-top: 40px; font-family: var(--f-mono); font-size: 12px; color: var(--muted); }}
@media (max-width: 480px) {{
  details.ep summary {{ grid-template-columns: 50px 1fr; }}
  .ad, .st {{ grid-column: 2; justify-self: start; }}
}}
</style>
<div class="wrap">
  <header class="hero">
    <span class="kicker">Midnight Files · Season 1</span>
    <h1>{total} nights of original horror</h1>
    <p>Every episode, in airing order. Tap an episode to read its script and caption. Episodes post on TikTok @midnight.files417 at 9:30 PM ET.</p>
    <div class="stats"><span><b>{len(order)}</b> series</span><span><b>{total}</b> episodes</span><span><b>{sched}</b> rendered &amp; scheduled</span><span>Nov 17, 2026 – Feb 15, 2027</span></div>
  </header>
  <nav class="index" aria-label="Series">{idx}</nav>
  {''.join(blocks)}
  <footer>Status as of {datetime.now(timezone.utc).strftime('%b %-d, %H:%M UTC')}. All stories, characters and places are fiction.</footer>
</div>
"""
    Path(out_path).write_text(page)


if __name__ == "__main__":
    import sys
    main(sys.argv[1])
