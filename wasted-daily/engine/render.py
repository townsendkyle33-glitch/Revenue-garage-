"""Vertical 9:16 renderer.

Layout: blurred full-bleed background, sharp gameplay centered, hook text at top,
word-by-word burned captions, punch-in zoom on the peak moment, whoosh SFX on open.
"""
import subprocess
from pathlib import Path

from . import config, media

W, H = 1080, 1920


def _ts(t):
    t = max(0.0, t)
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


def build_ass(path, hook, words, start, end):
    c = config.BRAND["colors"]
    hook = "".join(ch for ch in hook if ord(ch) < 0x2000).strip()   # on-screen font has no emoji
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {W}", f"PlayResY: {H}", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Hook,{config.FONT_NAME},92,{c['white']},{c['white']},{c['outline']},&H80000000,0,0,0,0,100,100,1,0,1,7,4,8,60,60,230,1",
        f"Style: Cap,{config.FONT_NAME},104,{c['white']},{c['yellow']},{c['outline']},&H80000000,0,0,0,0,100,100,1,0,1,8,4,2,60,60,430,1",
        f"Style: Tag,{config.FONT_NAME},44,{c['cyan']},{c['cyan']},{c['outline']},&H80000000,0,0,0,0,100,100,6,0,1,4,0,2,60,60,120,1",
        "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        f"Dialogue: 0,{_ts(0)},{_ts(end - start)},Hook,,0,0,0,,{{\\fad(150,0)}}{hook.upper()}",
        f"Dialogue: 0,{_ts(0)},{_ts(end - start)},Tag,,0,0,0,,WASTED DAILY",
    ]
    # Captions: chunks of up to 3 words, current word highlighted yellow with a pop.
    seg = [w for w in words if w["start"] >= start and w["end"] <= end + 0.2]
    chunks = [seg[i:i + 3] for i in range(0, len(seg), 3)]
    for ch in chunks:
        for j, w in enumerate(ch):
            ws = w["start"] - start
            we = ch[j + 1]["start"] - start if j + 1 < len(ch) else ch[-1]["end"] - start
            txt = " ".join(
                (f"{{\\c{c['yellow']}\\fscx112\\fscy112}}{x['word'].upper()}{{\\r}}" if x is w else x["word"].upper())
                for x in ch)
            lines.append(f"Dialogue: 1,{_ts(ws)},{_ts(max(we, ws + 0.1))},Cap,,0,0,0,,{txt}")
    Path(path).write_text("\n".join(lines), encoding="utf-8")


def render(src, out, start, end, hook, words, peak=None):
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    ass = out.with_suffix(".ass")
    build_ass(ass, hook, words, start, end)
    dur = end - start
    p = (peak - start) if peak is not None else dur * 0.6
    zoom = f"1+0.18*between(t\\,{max(0, p - 0.4):.2f}\\,{p + 1.6:.2f})"
    fonts = str(config.FONT_DIR)
    vf = (
        f"[0:v]split[a][b];"
        f"[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=25:2,eq=brightness=-0.12[bg];"
        f"[b]scale='trunc({W}*({zoom})/2)*2':-2:eval=frame[fg];"
        f"[bg][fg]overlay=x='(W-w)/2':y='(H-h)/2':eval=frame,"
        f"ass='{ass}':fontsdir='{fonts}'[v]"
    )
    inputs = ["-ss", f"{start:.2f}", "-t", f"{dur:.2f}", "-i", str(src),
              "-i", str(config.SFX / "whoosh.wav")]
    if media.has_audio(src):
        af = "[0:a]loudnorm=I=-14:TP=-1.5:LRA=11[g];[1:a]adelay=0|0[s];[g][s]amix=inputs=2:duration=first:normalize=0[aout]"
    else:
        af = "[1:a]apad[aout]"
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs,
           "-filter_complex", vf + ";" + af, "-map", "[v]", "-map", "[aout]", "-t", f"{dur:.2f}",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30",
           "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True)
    return out
