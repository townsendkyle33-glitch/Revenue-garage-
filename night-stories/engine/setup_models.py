"""One-time setup in a fresh container: Python packages + Kokoro voice model (from Hugging Face)."""
import os
import subprocess
import sys
from pathlib import Path

DIR = Path(os.environ.get("KOKORO_DIR", "/home/user/models/kokoro"))
VOICES = ["am_onyx", "am_michael", "bm_george", "bm_fable", "am_adam", "af_heart", "bf_emma"]


def main():
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "kokoro-onnx", "soundfile", "faster-whisper"], check=True)
    if (DIR / "model.onnx").exists() and (DIR / "voices.npz").exists():
        print("models present"); return
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    import shutil
    import numpy as np
    from huggingface_hub import hf_hub_download
    repo = "onnx-community/Kokoro-82M-v1.0-ONNX"
    DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy(hf_hub_download(repo, "onnx/model.onnx"), DIR / "model.onnx")
    np.savez(DIR / "voices.npz", **{v: np.fromfile(hf_hub_download(repo, f"voices/{v}.bin"), dtype=np.float32).reshape(-1, 1, 256)
                                     for v in VOICES})
    print("models ready")


if __name__ == "__main__":
    main()
