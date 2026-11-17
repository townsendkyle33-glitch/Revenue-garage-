"""Highlight detection.

Scores every second of footage on three signals, then picks the best
non-overlapping windows:
  1. Audio spikes  - sudden loudness jumps (crashes, explosions, screaming, laughing)
  2. Visual chaos  - clusters of scene changes / big motion
  3. Hype speech   - reaction words in the transcript ("no way", "bro", "oh my god"...)
Each pick comes with reasons so the decision is explainable on the dashboard.
"""
import re

import numpy as np

from . import config, media

HYPE = {
    "no way": 3, "oh my god": 3, "omg": 2, "what the": 3, "bro": 1.5, "yo": 1, "run": 1.5,
    "go go": 2, "let's go": 2.5, "wait": 1, "dude": 1, "insane": 2.5, "crazy": 2, "help": 1.5,
    "nooo": 3, "no no": 2.5, "haha": 2.5, "lol": 2, "why": 1, "dead": 1.5, "wasted": 2,
    "chase": 2, "cops": 2, "police": 2, "crash": 2.5, "jump": 1.5, "flip": 2,
}

CATEGORY_WORDS = {
    "rp": ["officer", "sir", "license", "arrest", "court", "judge", "mayor", "gang", "rp", "server", "character"],
    "cars": ["car", "drift", "speed", "engine", "turbo", "supercar", "race", "drive", "tuned", "mod", "wheel"],
    "chase": ["cops", "police", "chase", "chasing", "pursuit", "wanted", "stars", "heli", "roadblock"],
    "funny": ["haha", "ha ha", "lol", "bro", "why", "no way", "what the", "dude", "nooo"],
}


def _z(x):
    return (x - x.mean()) / (x.std() + 1e-6) if len(x) else x


def score_timeline(path, words):
    dur = media.duration(path)
    n = int(np.ceil(dur))
    audio = np.zeros(n)
    loud = media.loudness(path, hop=0.5)
    if len(loud):
        per_sec = loud[: (len(loud) // 2) * 2].reshape(-1, 2).max(axis=1)
        jump = np.maximum(0, np.diff(per_sec, prepend=per_sec[0]))      # sudden rises
        a = 0.6 * _z(per_sec) + 0.4 * _z(jump)
        audio[: len(a)] = np.clip(a[:n], 0, None)

    visual = np.zeros(n)
    for t in media.scene_cuts(path):
        i = int(t)
        if i < n:
            visual[max(0, i - 1): i + 2] += 1.0
    visual = np.clip(visual, 0, 3)

    speech = np.zeros(n)
    text = [(w["start"], w["word"].lower()) for w in words]
    for i, (t, _) in enumerate(text):
        window = " ".join(re.sub(r"[^a-z' ]", "", w) for _, w in text[i: i + 3])
        for k, v in HYPE.items():
            if window.startswith(k):
                speech[min(int(t), n - 1)] += v
    return dur, audio, visual, speech


def pick(path, words, k=config.CLIPS_PER_SOURCE):
    dur, audio, visual, speech = score_timeline(path, words)
    total = 1.0 * audio + 0.6 * visual + 0.8 * speech
    smooth = np.convolve(total, np.ones(3) / 3, mode="same")
    taken, picks = np.zeros(len(smooth), bool), []
    for peak in np.argsort(-smooth):
        if len(picks) >= k or smooth[peak] <= 0.5:
            break
        start = max(0, peak - 10)                       # setup before the payoff
        end = min(dur, peak + 6)                        # end shortly after the payoff
        if end - start < config.CLIP_MIN_SEC:
            start = max(0, end - config.CLIP_MIN_SEC)
        end = min(end, start + config.CLIP_MAX_SEC)
        s, e = int(start), int(np.ceil(end))
        if taken[s:e].any():
            continue
        # snap start/end to word gaps so we don't cut mid-sentence
        for w in words:
            if w["start"] < start < w["end"]:
                start = w["start"]
            if w["start"] < end < w["end"]:
                end = w["end"]
        taken[s:e] = True
        reasons = []
        if audio[peak] > 0.8: reasons.append(f"audio spike ({audio[peak]:.1f}σ)")
        if visual[max(0, peak - 2): peak + 3].sum() >= 1: reasons.append("visual action / cuts")
        if speech[max(0, peak - 3): peak + 3].sum() > 0: reasons.append("hype reaction in speech")
        picks.append({"start": round(float(start), 2), "end": round(float(end), 2),
                      "peak": float(peak), "score": round(float(smooth[peak]), 2),
                      "reasons": reasons or ["combined signal"]})
    return sorted(picks, key=lambda p: -p["score"])


def categorize(transcript, source_title=""):
    t = f"{transcript} {source_title}".lower()
    best = max(CATEGORY_WORDS, key=lambda c: sum(t.count(w) for w in CATEGORY_WORDS[c]))
    return best if any(w in t for w in CATEGORY_WORDS[best]) else "funny"
