"""Schedule a hosted story video on the Midnight Files channels through Buffer.
Usage: python3 -m engine.post stories/001-x.json "2026-11-19T02:30:00Z"   (UTC time)"""
import json
import sys
from pathlib import Path

import requests

from . import host

BUFFER_API = "https://api.buffer.com"
CHANNELS = {"tiktok": "6afd1c11ece6dfde5f041443"}   # @midnight.files417
LOG = Path(__file__).resolve().parent.parent / "posted.jsonl"


def gql(q, v):
    r = requests.post(BUFFER_API, json={"query": q, "variables": v},
                      headers={"Authorization": "Bearer proxy-injected"}, timeout=60)
    r.raise_for_status()
    b = r.json()
    if b.get("errors"):
        raise RuntimeError(b["errors"])
    return b["data"]


def schedule(story_path, due_utc):
    story = json.loads(Path(story_path).read_text())
    video = Path(story_path).resolve().parent.parent / "out" / f"{Path(story_path).stem}.mp4"
    url = host.host(video)
    out = []
    for plat, cid in CHANNELS.items():
        meta = {"tiktok": {"title": story["title"][:90], "isAiGenerated": True}} if plat == "tiktok" else {}
        q = """mutation($i:CreatePostInput!){createPost(input:$i){ __typename
                 ... on PostActionSuccess { post { id status dueAt } } ... on MutationError { message } }}"""
        r = gql(q, {"i": {"channelId": cid, "text": story["caption"], "assets": [{"video": {"url": url}}],
                          "mode": "customScheduled", "dueAt": due_utc, "schedulingType": "automatic",
                          "needsApproval": False, "saveToDraft": False, "source": "night-stories-engine",
                          "metadata": meta}})["createPost"]
        if "post" not in r:
            raise RuntimeError(r)
        rec = {"story": Path(story_path).stem, "platform": plat, "buffer_post_id": r["post"]["id"],
               "due": due_utc, "url": url}
        with LOG.open("a") as f:
            f.write(json.dumps(rec) + "\n")
        out.append(rec)
    return out


if __name__ == "__main__":
    print(schedule(sys.argv[1], sys.argv[2]))
