"""House format for every Wasted Daily post: streamer facecam on top, gameplay below, hook bar on the seam,
word-by-word captions on the gameplay. Owner's rule (Nov 21): same layout on every post.

Input: a landscape original (Twitch clip download, free) or an OpusClip "fit" render (1080x1920, 16:9 picture centered).
The facecam is found by face detection; clips where no stable face is found return None (= not our format)."""
import subprocess
from collections import Counter
from pathlib import Path

from . import config, render, transcribe

W, H = 1080, 1920
BAND_Y, BAND_H = (H - 608) // 2, 608          # where OpusClip puts the 16:9 frame in a fit render
TOP_H = 800                                     # facecam area; gameplay gets the rest
BAD = {"fuck", "fucking", "fucked", "shit", "bitch", "nigga", "niggas", "pussy", "dick", "hoe", "hoes"}


def band_of(path):
    """(x, y, w, h) of the 16:9 stream picture: the whole frame for a landscape original (Twitch download),
    or the centered strip of an OpusClip vertical fit render."""
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True).stdout.strip().split(",")
    w, h = int(out[0]), int(out[1])
    if w > h:
        return 0, 0, w, h
    bh = int(w * 9 / 16)
    return 0, (h - bh) // 2, w, bh


def find_cam(path, samples=20):
    """Return (x, y, w, h) of the facecam box inside the stream picture, or None."""
    import cv2
    import numpy as np
    det = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    BX, BY, BW, BH = band_of(path)
    k = BW / 1080                                 # detector sizes are tuned for a 1080-wide picture
    cap = cv2.VideoCapture(str(path))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    hits = []
    for i in np.linspace(0, n - 1, samples).astype(int):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(i))
        ok, f = cap.read()
        if not ok:
            continue
        band = cv2.cvtColor(f[BY:BY + BH, BX:BX + BW], cv2.COLOR_BGR2GRAY)
        for (x, y, w, h) in det.detectMultiScale(band, 1.1, 4, minSize=(int(20 * k), int(20 * k))):
            hits.append((x + w // 2, y + h // 2, w))
    if not hits:
        return None
    # A real facecam sits still: take the position bucket seen in the most frames.
    g = int(60 * k)
    buckets = Counter((cx // g, cy // g) for cx, cy, _ in hits)
    (bx, by), count = buckets.most_common(1)[0]
    if count < samples * 0.3:
        return None
    sel = [(cx, cy, w) for cx, cy, w in hits if (cx // g, cy // g) == (bx, by)]
    cx = int(np.median([s[0] for s in sel])); cy = int(np.median([s[1] for s in sel]))
    fw = int(np.median([s[2] for s in sel]))
    bw = min(BW, int(fw * 4.6)); bh = int(bw * TOP_H / W)
    if bh > BH:
        bh = BH; bw = int(bh * W / TOP_H)
    x = max(0, min(BW - bw, cx - bw // 2)); y = max(0, min(BH - bh, cy - int(bh * 0.45)))
    return x, y, bw, bh


def _clean(words):
    out = []
    for w in words:
        core = "".join(ch for ch in w["word"].lower() if ch.isalpha())
        out.append(dict(w, word=(w["word"][0] + "*" * (len(w["word"]) - 1)) if core in BAD else w["word"]))
    return out


def build(src, out, hook):
    """Render the house split layout. Returns out path, or None if the clip has no usable facecam."""
    cam = find_cam(src)
    if not cam:
        return None
    x, y, bw, bh = cam
    out = Path(out); out.parent.mkdir(parents=True, exist_ok=True)
    words = _clean(transcribe.words(src))
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src)],
                               capture_output=True, text=True).stdout.strip() or 0)
    ass = out.with_suffix(".ass")
    _ass(ass, hook, words, dur)
    BX, BY, BW, BH = band_of(src)
    gh = H - TOP_H
    gw = int(BH * W / gh)                        # gameplay crop width at full picture height
    gx = (BW - gw) // 2
    vf = (f"[0:v]crop={BW}:{BH}:{BX}:{BY}[band];[band]split[a][b];"
          f"[a]crop={bw}:{bh}:{x}:{y},scale={W}:{TOP_H}:flags=lanczos,unsharp=5:5:0.8[top];"
          f"[b]crop={gw}:{BH}:{gx}:0,scale={W}:{gh}:flags=lanczos,unsharp=5:5:0.5[bot];"
          f"[top][bot]vstack,drawbox=x=0:y={TOP_H - 3}:w={W}:h=6:color=black@1:t=fill,"
          f"ass='{ass}':fontsdir='{config.FONT_DIR}'[v]")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-filter_complex",
           vf + ";[0:a]loudnorm=I=-14:TP=-1.5:LRA=11[a]", "-map", "[v]", "-map", "[a]",
           "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-r", "30",
           "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True)
    return out


def _ass(path, hook, words, dur):
    c = config.BRAND["colors"]
    hook = "".join(ch for ch in hook if ord(ch) < 0x2000).strip().upper()
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {W}", f"PlayResY: {H}", "WrapStyle: 0", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        # Hook: black text on a white box, centered on the seam between cam and gameplay.
        f"Style: Hook,{config.FONT_NAME},64,&H00000000,&H00000000,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,1,0,3,14,0,5,90,90,0,1",
        f"Style: Cap,{config.FONT_NAME},96,{c['white']},{c['yellow']},{c['outline']},&H80000000,0,0,0,0,100,100,1,0,1,8,4,2,60,60,330,1",
        f"Style: Tag,{config.FONT_NAME},40,{c['cyan']},{c['cyan']},{c['outline']},&H80000000,0,0,0,0,100,100,6,0,1,4,0,2,60,60,70,1",
        "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        f"Dialogue: 2,{render._ts(0)},{render._ts(dur)},Hook,,0,0,0,,{{\\pos({W // 2},{TOP_H})}}{hook}",
        f"Dialogue: 0,{render._ts(0)},{render._ts(dur)},Tag,,0,0,0,,WASTED DAILY",
    ]
    chunks = [words[i:i + 3] for i in range(0, len(words), 3)]
    for ch in chunks:
        for j, w in enumerate(ch):
            ws = w["start"]; we = ch[j + 1]["start"] if j + 1 < len(ch) else ch[-1]["end"]
            txt = " ".join((f"{{\\c{c['yellow']}\\fscx110\\fscy110}}{x['word'].upper()}{{\\r}}" if x is w else x["word"].upper())
                           for x in ch)
            lines.append(f"Dialogue: 1,{render._ts(ws)},{render._ts(max(we, ws + 0.1))},Cap,,0,0,0,,{txt}")
    Path(path).write_text("\n".join(lines), encoding="utf-8")
