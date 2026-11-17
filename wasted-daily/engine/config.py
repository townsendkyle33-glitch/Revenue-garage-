"""Central config for the Wasted Daily content engine."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # wasted-daily/
DATA = ROOT / "data"
DB_PATH = DATA / "empire.db"
FOOTAGE_INBOX = ROOT / "footage" / "inbox"
RAW = ROOT / "media" / "raw"
EDITS = ROOT / "media" / "edits"
REPORTS = ROOT / "reports"
FONT_DIR = ROOT / "assets" / "fonts"
FONT_NAME = "Anton"
SFX = ROOT / "assets" / "sfx"

BRAND = {
    "name": "Wasted Daily",
    "credit_prefix": "🎥",
    "colors": {"cyan": "&H00FFE500", "white": "&H00FFFFFF", "yellow": "&H0066D1FF", "outline": "&H002A0012"},
}

# --- Rights gate -----------------------------------------------------------
# Footage is processed ONLY if its rights status is one of these.
#   owned       = we recorded it ourselves
#   licensed    = written permission / license from the creator on file
#   submission  = creator submitted it through our form and accepted the terms
ALLOWED_RIGHTS = {"owned", "licensed", "submission"}

# --- Publishing gate -------------------------------------------------------
#   "off"    : never touch Buffer
#   "draft"  : create Buffer drafts only (owner approves in Buffer)  <- default
#   "auto"   : schedule for real. Only after the owner explicitly authorizes.
PUBLISH_MODE = "draft"

BUFFER_API = "https://api.buffer.com"
BUFFER_ORG = "6afccf9d4775b0917da229e5"
CHANNELS = {
    "x":         {"id": "6afcd488ece6dfde5fffac62", "service": "twitter",   "handle": "@WastedDailyClip"},
    "instagram": {"id": "6afcd42aece6dfde5fffa8a5", "service": "instagram", "handle": "@wasted.dailyclipss"},
    "tiktok":    {"id": "6afcd2e5ece6dfde5fff99f6", "service": "tiktok",    "handle": "@wasteddailyclips8"},
    # youtube / facebook / threads: not connected yet (Buffer free plan = 3 channels)
}

# Media must be at a public, permanent HTTPS URL for Buffer to fetch it.
# Set this once storage is chosen (see ARCHITECTURE.md, "Media hosting").
PUBLIC_MEDIA_BASE_URL = None

TIMEZONE = "America/New_York"
DAILY_SLOTS_ET = ["09:00", "11:30", "14:00", "17:00", "19:30", "22:00"]

CLIP_MIN_SEC = 7
CLIP_MAX_SEC = 30
CLIPS_PER_SOURCE = 5

MONTHLY_TARGET_USD = 10_000
REVENUE_TARGETS = {"platform": 3000, "sponsorship": 3000, "affiliate": 1000, "services": 3000}
