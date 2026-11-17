"""FFmpeg helpers: probe, audio loudness curve, scene cuts."""
import json
import re
import subprocess

import numpy as np


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, check=True)


def duration(path):
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)]).stdout
    return float(json.loads(out)["format"]["duration"])


def has_audio(path):
    out = run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
               "-of", "csv=p=0", str(path)]).stdout
    return bool(out.strip())


def loudness(path, hop=0.5, sr=16000):
    """RMS loudness (dB) per `hop` seconds."""
    if not has_audio(path):
        return np.zeros(0)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(sr),
                          "-f", "s16le", "-"], capture_output=True, check=True).stdout
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    n = int(sr * hop)
    frames = len(a) // n
    if frames == 0:
        return np.zeros(0)
    a = a[: frames * n].reshape(frames, n)
    rms = np.sqrt((a ** 2).mean(axis=1) + 1e-10)
    return 20 * np.log10(rms)


def scene_cuts(path, threshold=0.35):
    """Timestamps (s) of hard visual cuts / big motion changes."""
    p = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path), "-vf",
                        f"scale=320:-2,select='gt(scene,{threshold})',showinfo", "-an", "-f", "null", "-"],
                       capture_output=True, text=True)
    return [float(m) for m in re.findall(r"pts_time:([0-9.]+)", p.stderr)]
