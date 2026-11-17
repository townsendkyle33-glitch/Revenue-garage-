"""Buffer GraphQL client. The API key is injected by the session's network proxy;
it is never stored in code, env vars or the repo."""
import requests

from . import config


class BufferError(RuntimeError):
    pass


def gql(query, variables=None):
    r = requests.post(config.BUFFER_API, json={"query": query, "variables": variables or {}},
                      headers={"Authorization": "Bearer proxy-injected"}, timeout=60)
    r.raise_for_status()
    body = r.json()
    if body.get("errors"):
        raise BufferError(body["errors"])
    return body["data"]


def channels():
    q = "query($o:OrganizationId!){channels(input:{organizationId:$o}){id name service isDisconnected isLocked}}"
    return gql(q, {"o": config.BUFFER_ORG})["channels"]


def create_post(platform, copy, video_url, due_at=None, draft=True):
    ch = config.CHANNELS[platform]
    meta = {}
    if platform == "instagram":
        meta = {"instagram": {"type": "reel", "shouldShareToFeed": True}}
    elif platform == "tiktok":
        meta = {"tiktok": {"title": copy.get("title", "")[:90]}}
    elif platform == "youtube":
        meta = {"youtube": {"title": copy["title"], "privacy": "public", "madeForKids": False, "categoryId": "20"}}
    inp = {
        "channelId": ch["id"], "text": copy["text"], "assets": [{"video": {"url": video_url}}],
        "mode": "customScheduled" if due_at else "addToQueue", "schedulingType": "automatic",
        "needsApproval": False, "saveToDraft": draft, "source": "wasted-daily-engine",
    }
    if due_at:
        inp["dueAt"] = due_at
    if meta:
        inp["metadata"] = meta
    q = """mutation($i:CreatePostInput!){createPost(input:$i){
             __typename ... on PostActionSuccess { post { id status dueAt } }
             ... on MutationError { message } }}"""
    res = gql(q, {"i": inp})["createPost"]
    if "post" not in res:
        raise BufferError(res.get("message", res))
    return res["post"]


def sent_posts_with_metrics(first=50):
    q = """query($o:OrganizationId!,$f:Int){posts(first:$f,input:{organizationId:$o,filter:{status:[sent]}}){
             edges{node{id channelService sentAt externalLink metricsUpdatedAt
               metrics{type value}}}}}"""
    data = gql(q, {"o": config.BUFFER_ORG, "f": first})["posts"]
    return [e["node"] for e in data["edges"]]
