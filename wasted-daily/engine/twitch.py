"""Twitch Helix: find streamers' latest GTA 6 VODs to send to OpusClip.
Credentials come from env vars TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET (set by the owner in the
environment settings). They are never printed, logged or written to disk."""
import os
from datetime import datetime, timedelta, timezone

import requests

STREAMERS = ["lacy", "kaicenat", "xqc", "jynxzi", "plaqueboymax", "stableronaldo",
             "theburntpeanut", "marlon", "ishowspeed", "caseoh_", "zackrawrr", "jasontheween"]
GTA_WORDS = ("gta", "grand theft", "vice city", "leonida")
_token = None


def _creds():
    cid, sec = os.environ.get("TWITCH_CLIENT_ID"), os.environ.get("TWITCH_CLIENT_SECRET")
    if not cid or not sec:
        raise SystemExit("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set in this environment yet")
    return cid, sec


def _headers():
    global _token
    cid, sec = _creds()
    if not _token:
        r = requests.post("https://id.twitch.tv/oauth2/token", timeout=30,
                          data={"client_id": cid, "client_secret": sec, "grant_type": "client_credentials"})
        r.raise_for_status()
        _token = r.json()["access_token"]
    return {"Client-Id": cid, "Authorization": f"Bearer {_token}"}


def _get(path, **params):
    r = requests.get(f"https://api.twitch.tv/helix/{path}", headers=_headers(), params=params, timeout=30)
    r.raise_for_status()
    return r.json()["data"]


def gta_vods(logins=STREAMERS, days=4, per_user=3):
    """Recent archived streams whose title mentions GTA. Live (still-recording) VODs are skipped."""
    users = _get("users", login=list(logins))
    live = {s["user_id"] for s in _get("streams", user_id=[u["id"] for u in users], first=100)}
    since = datetime.now(timezone.utc) - timedelta(days=days)
    out = []
    for u in users:
        n = 0
        for v in _get("videos", user_id=u["id"], type="archive", first=10):
            made = datetime.fromisoformat(v["created_at"].replace("Z", "+00:00"))
            if made < since or not any(w in v["title"].lower() for w in GTA_WORDS):
                continue
            if u["id"] in live and n == 0:      # newest VOD of a live channel is still recording
                n += 1
                continue
            out.append({"login": u["login"], "name": u["display_name"], "url": v["url"],
                        "title": v["title"], "duration": v["duration"], "created": v["created_at"]})
            n += 1
            if n >= per_user:
                break
    return out


def gta_clips(logins=STREAMERS, days=3, per_user=4, min_views=2000):
    """Most-viewed recent Twitch clips per streamer from the GTA VI category.
    Clips are short, single moments that viewers already found funny: the owner's exact style.
    (Full marathon VODs run 24h+, over OpusClip's 10h limit.)"""
    game = _get("games", name="Grand Theft Auto VI")
    gid = game[0]["id"] if game else None
    users = _get("users", login=list(logins))
    start = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = []
    for u in users:
        got = [c for c in _get("clips", broadcaster_id=u["id"], started_at=start, first=50)
               if (not gid or c["game_id"] == gid) and c["view_count"] >= min_views]
        for c in sorted(got, key=lambda c: -c["view_count"])[:per_user]:
            out.append({"login": u["login"], "name": u["display_name"], "url": c["url"], "title": c["title"],
                        "duration": f"{int(c['duration'])}s", "views": c["view_count"], "created": c["created_at"]})
    return out
