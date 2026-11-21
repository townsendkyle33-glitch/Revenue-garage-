"""Publish a finished video to the public night-stories-media repo and return a URL Buffer can fetch."""
import shutil
import subprocess
from pathlib import Path

MEDIA_REPO = Path("/home/user/night-stories-media")
REMOTE = "https://github.com/townsendkyle33-glitch/night-stories-media"
RAW = "https://raw.githubusercontent.com/townsendkyle33-glitch/night-stories-media/main/videos/"


def _git(*args):
    return subprocess.run(["git", "-C", str(MEDIA_REPO), *args], check=True, capture_output=True, text=True).stdout


def ensure_clone():
    if not (MEDIA_REPO / ".git").exists():
        subprocess.run(["git", "clone", "--depth", "1", REMOTE, str(MEDIA_REPO)], check=True)


def host(video_path, subdir="videos"):
    ensure_clone()
    _git("pull", "-q", "--ff-only", "origin", "main")
    dest = MEDIA_REPO / subdir / Path(video_path).name
    dest.parent.mkdir(exist_ok=True)
    shutil.copy2(video_path, dest)
    _git("add", str(dest))
    if _git("status", "--porcelain"):
        _git("commit", "-q", "-m", f"Add {dest.name}")
        _git("-c", "push.negotiate=true", "push", "-q", "origin", "main")
    return RAW.replace("/videos/", f"/{subdir}/") + dest.name
