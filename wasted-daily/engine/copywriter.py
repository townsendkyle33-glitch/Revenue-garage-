"""Hooks, titles, captions and hashtags, written per platform."""
import hashlib

HOOKS = {
    "funny": ["He did NOT see that coming 💀", "This is why I don't trust NPCs", "Wait for it…",
              "The physics in this game 😭", "Worst getaway ever", "Bro had ONE job"],
    "rp": ["Cop pulls over the wrong guy", "This RP scene went off the rails", "The judge had enough",
           "Funniest traffic stop in RP", "He talked his way out of THIS?"],
    "cars": ["Cleanest build in Los Santos", "This car is not street legal", "Watch the drift 👀",
             "0 to wasted in 3 seconds", "Rate this build 1-10"],
    "chase": ["5 stars and no plan", "The cops were NOT ready", "Craziest escape you'll see today",
              "This chase ends in the worst way"],
}

TAGS = {
    "funny": ["gta", "gtafunny", "gtaclips", "gaming", "funnymoments"],
    "rp": ["gtarp", "gta", "roleplay", "gtaclips", "fivem"],
    "cars": ["gtacars", "gta", "carmeet", "gtaclips", "gaming"],
    "chase": ["gta", "policechase", "gtaclips", "gaming", "gtaonline"],
}


def _pick(options, seed):
    return options[int(hashlib.md5(seed.encode()).hexdigest(), 16) % len(options)]


def hook_for(category, transcript, seed):
    return _pick(HOOKS.get(category, HOOKS["funny"]), seed + transcript[:20])


def write(clip, credit_handle=None):
    cat, hook = clip["category"], clip["hook"]
    credit = f"\n\n🎥 {credit_handle}" if credit_handle else ""
    tags = TAGS.get(cat, TAGS["funny"])
    return {
        # X: no hashtags, short, credit last
        "x": {"text": f"{hook}{credit}"},
        # Instagram: hook, value line, credit, 3-5 hashtags
        "instagram": {"text": f"{hook}\n\nFollow for daily GTA clips.{credit}\n\n" + " ".join("#" + t for t in tags[:5])},
        # TikTok: short caption + a few tags; title field used too
        "tiktok": {"text": f"{hook}{credit} " + " ".join("#" + t for t in tags[:4]), "title": hook[:90]},
        # YouTube Shorts: title <= 100 chars incl. #shorts
        "youtube": {"title": f"{hook} #shorts"[:100],
                    "text": f"{hook}{credit}\n\nDaily GTA funny moments, cars & RP.\n#gta #shorts"},
        "facebook": {"text": f"{hook}{credit}"},
    }
