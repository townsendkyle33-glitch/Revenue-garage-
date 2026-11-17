"""Speech-to-text with word timestamps (faster-whisper, runs locally, free)."""
import os

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
_model = None


def model(size="base.en"):
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel(size, device="cpu", compute_type="int8")
    return _model


def words(path):
    """[{'start','end','word'}] for the whole file. Empty list if no speech."""
    import subprocess
    import numpy as np
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    if not raw:
        return []
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    segs, _ = model().transcribe(audio, word_timestamps=True, vad_filter=True)
    out = []
    for s in segs:
        for w in s.words or []:
            out.append({"start": round(w.start, 2), "end": round(w.end, 2), "word": w.word.strip()})
    return out


def text_between(ws, start, end):
    return " ".join(w["word"] for w in ws if w["start"] >= start and w["end"] <= end).strip()
