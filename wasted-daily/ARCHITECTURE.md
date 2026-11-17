# Wasted Daily — Architecture & Operating Plan

Dashboard: **Wasted Daily HQ** — https://claude.ai/artifact/HXa6ocaNUu5SopMfo8tiHb (private; opens on iPad)

## Pipeline

```
footage/inbox/*.mp4 + rights sidecar .json
        │  ingest (rights gate: owned | licensed | submission + proof)
        ▼
media/raw ──► transcribe (faster-whisper, local, free)
        │
        ▼
detect: audio spikes + scene/motion cuts + hype words ──► top-N timestamps + reasons
        │
        ▼
render (FFmpeg): 9:16 blurred bg · centered gameplay · punch-in zoom on peak ·
                 hook text · word-by-word captions · whoosh SFX · -14 LUFS loudness
        │
        ▼
copywriter: per-platform text (X no hashtags; IG 3-5 tags; TikTok title; Shorts title)
        │
        ▼
approval (status awaiting_approval → approved)
        │
        ▼
queue → Buffer GraphQL (PUBLISH_MODE: off | draft | auto) at ET slots
        │
        ▼
metrics ← Buffer post metrics (views, reach, likes, shares, saves, follows, avg watch time)
        │
        ▼
report: daily executive report (reports/YYYY-MM-DD.md) + dashboard files (data/dash/*.json)
```

All state lives in `data/empire.db` (SQLite): sources, clips, posts, metrics, money, events.

## Commands

```
cd wasted-daily
python3 -m engine ingest PATH --rights owned --title "..."          # or licensed/submission + --proof URL
python3 -m engine run-inbox                                         # everything in footage/inbox with a .json sidecar
python3 -m engine process SOURCE_ID
python3 -m engine approve CLIP_ID ...
python3 -m engine queue
python3 -m engine metrics
python3 -m engine money revenue sponsorship 250 --verified --note "Brand X"
python3 -m engine report
```

Sidecar example (`footage/inbox/chase01.json`):
`{"rights": "licensed", "creator": "Name", "handle": "@name", "title": "Cop chase", "proof": "https://link-to-signed-permission"}`

## Accounts & access (current)

| Thing | Status |
|---|---|
| X @WastedDailyClip | connected via Buffer |
| Instagram @wasted.dailyclipss (Creator) | connected via Buffer |
| TikTok @wasteddailyclips8 | connected via Buffer |
| YouTube, Facebook, Threads | not connected (Buffer free plan = 3 channels) |
| Buffer API | key stored in the `wasted-daily` cloud environment (proxy-injected, never in repo) |
| OpusClip API | key stored the same way; optional engine for long VODs |

## Blockers and the fastest legitimate fix

1. **Footage rights.** The engine only processes owned, licensed, or submitted footage.
   - Fastest: record our own GTA V / GTA VI gameplay (console capture or PC with OBS) and drop it in the inbox.
   - Next: creator licensing. DM RP/funny streamers: "we edit your best moments into Shorts, credit you, and send you the files free" in exchange for written permission. That is also the seed of the clipping-services revenue stream.
   - Rockstar's own policy on gameplay videos and Twitch/YouTube creators' terms must be checked before monetizing any compilation.
2. **Public video hosting.** Buffer fetches video from a public HTTPS URL. Options: Cloudflare R2 public bucket (free tier, needs a card on file → owner approval), or a separate public GitHub repo for finished clips (free). Owner decision.
3. **Publishing authorization.** PUBLISH_MODE is `draft`. Switch to `auto` only after the owner says so.
4. **Buffer plan.** Free plan caps at 3 channels. Upgrade needs owner approval.

## Revenue plan (planning targets, not forecasts)

| Stream | Target | Path | Earliest realistic start |
|---|---|---|---|
| Platform payouts | $3,000 | YouTube Partner Program (Shorts), TikTok creator rewards (needs 1-min+ originals), Facebook. Original gameplay qualifies far more reliably than third-party compilations. | After eligibility thresholds are met |
| Sponsorships | $3,000 | Gaming gear, energy drinks, VPN/game-key sellers need proof of audience: ~50k+ engaged followers network-wide | Month 2-3 |
| Affiliates | $1,000 | Amazon/gear links in bio, game-key partner programs | Once traffic exists |
| Clipping services | $3,000 | Sell this exact pipeline to streamers: e.g. 30 Shorts/month per creator. Three to six clients cover the target. | Can start this month |

The clipping-services stream does not depend on our follower count, so it is the fastest path to real revenue.

## Safety rules the code enforces
- Rights gate on every source.
- No posting while PUBLISH_MODE != auto; drafts only.
- Every failure is logged to `events` and shown on the dashboard.
- Credentials never written to disk or repo.
