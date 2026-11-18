"""AI scary-story video renderer.

story JSON  ->  narration (Kokoro TTS, local, free)
            ->  one image per scene (provider: placeholder | fal)
            ->  slow zoom/pan per image, crossfades
            ->  word-by-word captions (timed with Whisper on our own narration)
            ->  low ambient drone + hook title
            ->  1080x1920 MP4
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
MODELS = Path(os.environ.get("KOKORO_DIR", "/home/user/models/kokoro"))
FONT_DIR = ROOT / "assets"
W, H, FPS = 1080, 1920, 30
VOICE = {"name": "am_onyx", "lang": "en-us", "speed": 0.9}


def tts(text, out, voice=VOICE):
    from kokoro_onnx import Kokoro
    k = Kokoro(str(MODELS / "model.onnx"), str(MODELS / "voices.npz"))
    samples, sr = k.create(text, voice=voice["name"], speed=voice["speed"], lang=voice["lang"])
    sf.write(out, samples, sr)
    return len(samples) / sr


def image_placeholder(prompt, out, seed):
    """Dark atmospheric placeholder until an image API is connected (clearly not final art)."""
    rng = np.random.default_rng(seed)
    hue = int(rng.integers(180, 260))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    f"gradients=s=1296x2304:c0=0x05070d:c1=0x1b2433:c2=0x2a0d12:x0=0:y0=0:x1=1296:y1=2304:seed={seed}:n=3",
                    "-vf", f"hue=h={hue},noise=alls=18:allf=t,vignette=PI/3.2,boxblur=2", "-frames:v", "1", str(out)],
                   check=True)


def image_fal(prompt, out, seed, model="fal-ai/flux/schnell"):
    import time
    for attempt in range(4):
        try:
            return _image_fal_once(prompt, out, seed + attempt * 7, model)
        except Exception as e:
            if attempt == 3:
                raise
            print(f"fal retry {attempt + 1}: {e}", flush=True)
            time.sleep(5 * (attempt + 1))


def _image_fal_once(prompt, out, seed, model):
    import requests
    r = requests.post(f"https://fal.run/{model}", timeout=180,
                      headers={"Authorization": "Key proxy-injected", "Content-Type": "application/json"},
                      json={"prompt": prompt, "image_size": {"width": 1088, "height": 1920}, "num_images": 1,
                            "seed": seed, "enable_safety_checker": True, "sync_mode": True})
    r.raise_for_status()
    url = r.json()["images"][0]["url"]
    if url.startswith("data:"):                       # sync_mode returns the image inline (no CDN fetch)
        import base64
        Path(out).write_bytes(base64.b64decode(url.split(",", 1)[1]))
    else:
        Path(out).write_bytes(requests.get(url, timeout=120).content)


def words(audio_path):
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    from faster_whisper import WhisperModel
    a, sr = sf.read(audio_path, dtype="float32")
    if sr != 16000:
        a = np.interp(np.linspace(0, len(a), int(len(a) * 16000 / sr), endpoint=False), np.arange(len(a)), a).astype(np.float32)
    segs, _ = WhisperModel("base.en", device="cpu", compute_type="int8").transcribe(a, word_timestamps=True)
    out = []
    for w in (w for s in segs for w in (s.words or [])):
        t = w.word.strip()
        if out and t[:1] in ".:,'%" and out[-1]["word"][-1:].isdigit():   # "3" ".12" -> "3:12"
            out[-1]["word"] += (":" + t[1:]) if t[:1] in ".:" else t
            out[-1]["end"] = w.end
        else:
            out.append({"start": w.start, "end": w.end, "word": t})
    return out


def ass_ts(t):
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


def build_ass(path, title, ws, total, tag=None):
    head = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {W}", f"PlayResY: {H}", "", "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Title,Anton,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,0,0,0,0,100,100,2,0,1,6,3,8,70,70,260,1",
        "Style: Tag,Anton,46,&H004040FF,&H004040FF,&H00000000,&H90000000,0,0,0,0,100,100,8,0,1,4,0,8,70,70,190,1",
        "Style: Cap,Anton,92,&H00FFFFFF,&H004040FF,&H00000000,&H90000000,0,0,0,0,100,100,1,0,1,7,3,2,70,70,520,1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        f"Dialogue: 0,{ass_ts(0)},{ass_ts(3.2)},Title,,0,0,0,,{{\\fad(200,400)}}{title.upper()}",
    ]
    if tag:
        head.append(f"Dialogue: 0,{ass_ts(0)},{ass_ts(3.2)},Tag,,0,0,0,,{{\\fad(200,400)}}{tag.upper()}")
    chunks = [ws[i:i + 3] for i in range(0, len(ws), 3)]
    for ch in chunks:
        for j, w in enumerate(ch):
            s = w["start"]
            e = ch[j + 1]["start"] if j + 1 < len(ch) else ch[-1]["end"]
            txt = " ".join((f"{{\\c&H004040FF&}}{x['word'].upper()}{{\\r}}" if x is w else x["word"].upper()) for x in ch)
            head.append(f"Dialogue: 1,{ass_ts(s)},{ass_ts(max(e, s + 0.08))},Cap,,0,0,0,,{txt}")
    Path(path).write_text("\n".join(head), encoding="utf-8")


def render(story_path, provider="placeholder"):
    story = json.loads(Path(story_path).read_text())
    slug = Path(story_path).stem
    work = ROOT / "out" / slug
    work.mkdir(parents=True, exist_ok=True)
    scenes = story["scenes"]

    # 1) narration: one file per scene, then joined with short pauses
    parts, durs = [], []
    for i, sc in enumerate(scenes):
        p = work / f"n{i:02d}.wav"
        durs.append(tts(sc["narration"], p) + 0.35)
        parts.append(p)
    narr = work / "narration.wav"
    sr = 24000
    audio = np.concatenate([np.concatenate([sf.read(p)[0], np.zeros(int(0.35 * sr))]) for p in parts])
    sf.write(narr, audio, sr)
    total = len(audio) / sr + 0.8

    # 2) images
    imgs = []
    for i, sc in enumerate(scenes):
        out = work / f"img{i:02d}.png"
        if not out.exists():
            (image_fal if provider == "fal" else image_placeholder)(story["style"] + ", " + sc["image"], out, 1000 + i)
        imgs.append(out)

    # 3) motion per image (alternating slow push-in / pull-out), crossfaded
    seg = []
    for i, (img, d) in enumerate(zip(imgs, durs)):
        frames = int((d + 0.5) * FPS)
        z = "min(1+0.0009*on,1.25)" if i % 2 == 0 else "max(1.25-0.0009*on,1)"
        o = work / f"v{i:02d}.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-i", str(img), "-vf",
                        f"scale={int(W*1.25)}:{int(H*1.25)}:force_original_aspect_ratio=increase,crop={int(W*1.25)}:{int(H*1.25)},"
                        f"zoompan=z='{z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={W}x{H}:fps={FPS},"
                        "eq=contrast=1.06:saturation=0.9,format=yuv420p",
                        "-frames:v", str(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", str(o)], check=True)
        seg.append((o, d))
    # crossfade chain
    inputs, fc, last, off = [], [], "[0:v]", 0.0
    for i, (o, d) in enumerate(seg):
        inputs += ["-i", str(o)]
    for i in range(1, len(seg)):
        off += seg[i - 1][1]
        lbl = f"[x{i}]"
        fc.append(f"{last}[{i}:v]xfade=transition=fade:duration=0.5:offset={off - 0.25:.2f}{lbl}")
        last = lbl
    video = work / "video.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(fc) or "null",
                    "-map", last if fc else "0:v", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", str(video)], check=True)

    # 4) captions from our own narration
    ws = words(narr)
    ass = work / "captions.ass"
    tag = f"{story['series']}  |  Part {story['part']}" if story.get("part") else None
    build_ass(ass, story["title"], ws, total, tag)

    # 5) ambient drone under the voice, final mux
    final = ROOT / "out" / f"{slug}.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-i", str(video), "-i", str(narr),
        "-f", "lavfi", "-t", f"{total:.2f}", "-i", "anoisesrc=c=brown:a=0.05",
        "-f", "lavfi", "-t", f"{total:.2f}", "-i", "sine=f=55:sample_rate=48000",
        "-filter_complex",
        f"[0:v]ass='{ass}':fontsdir='{FONT_DIR}'[v];"
        "[2:a]lowpass=f=300,volume=0.6[n];[3:a]volume=0.05,tremolo=f=0.2:d=0.6[s];"
        "[n][s]amix=inputs=2:normalize=0,afade=t=in:d=2[bed];"
        "[1:a]aresample=48000,loudnorm=I=-15:TP=-1.5[vo];[vo][bed]amix=inputs=2:duration=first:normalize=0[a]",
        "-map", "[v]", "-map", "[a]", "-t", f"{total:.2f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(final)], check=True)
    return final, total


if __name__ == "__main__":
    f, t = render(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "placeholder")
    print(f, f"{t:.1f}s")
