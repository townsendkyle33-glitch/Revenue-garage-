# Night Stories (working name) — AI scary-story niche

Original scary/mystery stories, 60-90s vertical videos, one per night.

Pipeline: `stories/*.json` (script: title, style, caption, scenes[narration,image])
→ Kokoro TTS narration (local, free) → images (placeholder | fal.ai FLUX)
→ slow zoom/pan + crossfades → Whisper-timed captions → ambient drone → `out/<slug>.mp4`

Render: `cd night-stories && python3 -m engine.story stories/001-harlow-creek.json [placeholder|fal]`

Needs before going live:
1. fal.ai API key (stored as a network secret for fal.run; never in the repo)
2. Public GitHub repo for finished videos so Buffer can fetch them
3. Social accounts for this page + Buffer plan with more than 3 channels

Rules: original stories only (no retelling copyrighted stories or real crimes as fiction),
no real people named, no gore thumbnails, label as fiction in captions.
