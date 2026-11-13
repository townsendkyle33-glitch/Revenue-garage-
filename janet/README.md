# JANET — Personal AI Chief of Staff

A phone-based executive assistant for Aqua World Systems. You call her number (or she calls you), talk naturally,
and she remembers past calls, creates tasks and development tickets, schedules callbacks, and reads live Rep Site
and calendar data. Everything she does is stored in Postgres and visible in a private dashboard.

```
 your phone ──► Twilio number ──► /twilio/voice (signature + caller check)
                                        │ TwiML <Connect><Stream> (signed token)
                                        ▼
                 /twilio/media WebSocket ◄──► OpenAI Realtime (speech-to-speech, tools)
                                        │
            tool engine (allowlist, confirmations) ──► Postgres (Supabase): janet_* tables
                                        │                     ▲
            durable worker (janet_jobs) ┴── callbacks, retries, summaries, briefings
                                        │
                              Twilio REST: outbound calls ──► your phone
```

## Status: what is built and what has been proven

| Acceptance test | Status |
|---|---|
| I can call JANET's number | **Built, needs credentials.** Inbound webhook, caller check and audio bridge are tested end-to-end against a fake Twilio and a fake OpenAI. Not yet tested on a real phone call. |
| JANET answers and holds a natural conversation | Built: streaming μ-law audio both ways, semantic voice-activity detection, barge-in (playback cleared and reply truncated), reconnect if OpenAI drops. Voice quality and latency can only be judged on a real call. |
| JANET remembers something from a previous call | **Tested (simulated):** memory saved during call 1 appears in call 2's instructions before she speaks. |
| I can create a task verbally | **Tested (simulated):** spoken request → `create_task` → row in `janet_tasks`. |
| The task appears in persistent storage | **Tested** against real Postgres. |
| I can request a callback in five minutes | **Tested (simulated):** resolves the time in America/New_York, saves it, and queues a durable job. |
| JANET actually calls me at the scheduled time | **Tested with a fake Twilio client:** dials exactly once, even with parallel workers. Needs real credentials to ring a phone. |
| JANET remembers why she called | **Tested:** the callback's opening includes the reason, the original conversation's summary, and its open questions. |
| The callback appears in the dashboard | **Tested** (API, plus a headless browser at phone width). |
| Failed calls are logged and handled | **Tested:** no-answer/busy/failed → retry after 5 min (3 attempts) → `no_answer`. Voicemail leaves no private details. A crash mid-dial is flagged and never re-dialled automatically. |
| Unauthorized callers cannot access private information | **Tested:** an unknown number gets "this line is private". Unsigned webhooks get 403. A forged media-stream token is closed before reaching OpenAI. Optional keypad PIN. |
| Sensitive actions cannot execute without authorization | **Tested:** calendar writes and memory deletion only run after a *new* spoken utterance from you, enforced by the server. The model cannot confirm its own request. |
| Google Calendar | Built (OAuth, agenda, availability, create/move with confirmation, briefing input). **Untested against Google:** needs an OAuth client. |
| Rep Site read-only data | Built. **Tested against Rep Site's real schema** (all 61 migrations, locally) for training progress, Field Intelligence, Objection Trainer and University health. Not yet run against production data. |

Run the tests: `npm test` (needs a local Postgres; see Testing).

## 1. Existing infrastructure reused

- **Rep Site's Supabase Postgres** as the database. JANET adds only `janet_*` tables and touches no Rep Site table.
- **Rep Site's access model.** `janet_owners` and `janet_is_owner()` mirror the Lead Engine's `le_owners`. The first administrator is the owner, and being an admin alone does not grant access. Every JANET table has RLS, and the encrypted Google token can't be read from any browser.
- **The Lead Engine's patterns:** AES-GCM-encrypted Google refresh token, unique idempotency keys, lease-based job claiming (like `fi_claim_jobs`), and an append-only audit log.
- **Rep Site data**, through fixed read-only queries: `university_graduated()`, `lesson_progress`, `fi_recordings`, `fi_processing_jobs`, `objection_attempts`, `university_health_runs` and `university_client_issues`.
- **America/New_York** as the default timezone, same as `le_settings`.

**Why JANET is a separate service, not inside Rep Site:** Rep Site is a Lovable/TanStack app built for Cloudflare's serverless target. A phone call needs a WebSocket held open for the whole call, plus a worker that is always running (to fire callbacks at exact times and survive restarts). Serverless requests can't hold either. JANET therefore runs as one small always-on Node service that shares Rep Site's database.

## 2. Missing credentials and services (nothing is configured yet)

| Needed for | What | Where |
|---|---|---|
| Phone | Twilio account, a voice-capable number, Account SID + Auth Token | twilio.com console |
| Voice | OpenAI API key with Realtime access | platform.openai.com |
| Database | Supabase connection string for Rep Site's project (session pooler, port 5432) | Supabase → Settings → Database |
| Hosting | An always-on host with HTTPS + WebSockets (Render, Railway or Fly.io) | — |
| Dashboard | `JANET_ADMIN_PASSWORD`, `JANET_SESSION_SECRET` | you choose |
| Calendar | Google OAuth client (Web, **Internal**), redirect `https://<host>/admin/google/callback`, Calendar API enabled | Google Cloud console |
| Your phone | `JANET_OWNER_PHONE` (E.164) and optionally `JANET_CALLER_PIN` | — |

## 3. Database migrations

- `migrations/001_janet_core.sql` creates settings, conversations, messages (transcripts), calls, memories, tasks, callbacks, jobs, dev tickets, pending actions, integrations and audit. RLS is on, `anon`/`authenticated` are revoked, and the audit log is append-only.
- `migrations/002_rep_site_owner_access.sql` (Rep Site's database only) creates `janet_owners` and `janet_is_owner()`, plus owner-only read policies, ready for a future `/manage/janet` page in Rep Site. It skips itself on any other database.

`npm run migrate` applies them, tracked in `janet_schema_migrations`. The server also runs them at startup.
These live outside Rep Site's Lovable/drizzle chain on purpose, so no Rep Site code changes. If you'd rather keep
every schema change in Rep Site, copy both files into `rep-site/drizzle/migrations/` as `0061_janet.sql`.

## 4. Estimated running costs (estimates; check current pricing pages)

| Item | Cost |
|---|---|
| Twilio phone number | ~$1.15/month |
| Twilio voice | ~$0.0085/min inbound, ~$0.014/min outbound (US), plus a small Media Streams fee |
| OpenAI Realtime (speech-to-speech) | roughly $0.10–0.25 per conversation minute, depending on model and how much each side talks |
| Summaries (gpt-4.1-mini) | well under $0.01 per call |
| Hosting (always-on small instance) | ~$5–10/month |
| Supabase, Google Calendar | already paid / free |

**Rough total:** about **$25–50/month** at 5 minutes a day, or **$100–250/month** at 30 minutes a day. Realtime voice is almost all of it.

## 5. Dependencies and blockers

- **Blocker:** the credentials above. Everything else is built and tested.
- The Realtime event names follow OpenAI's GA API, and both GA and beta audio event names are handled. The first real call is the true test. If OpenAI rejects the session settings, the error shows in the server log and the Audit log tab (`realtime.error`).
- No Claude Code runner is connected. Dev tickets are recorded with status `created`, and JANET says out loud that development has not started. Status moves to `submitted → in_progress → fix_proposed → verified` only when you (or a future runner) change it.
- Recording consent: JANET never records audio. She stores **text transcripts of your own calls** (switchable off in Settings, deleted after 365 days by default). Florida is an all-party-consent state, so if you ever add other people to a call, turn transcripts off or tell them.

## 6. Exact steps to a working phone-call MVP (about 30–45 minutes)

1. **Twilio:** buy a voice-capable local number.
2. **OpenAI:** create an API key.
3. **Host:** create a Web Service from this repo with root directory `janet/` and the Dockerfile (Render: "Docker" runtime; Railway/Fly work the same). Set the environment variables from `.env.example`. `PUBLIC_BASE_URL` is the service's https URL.
4. **Deploy.** Startup logs show `JANET configuration: {...}` with every item `true`, and migrations apply automatically. `GET /health` shows the same.
5. **Twilio number → Voice configuration:**
   - "A call comes in": Webhook `POST https://<host>/twilio/voice`
   - "Call status changes": `POST https://<host>/twilio/status`
6. **Call the number from your cell.** JANET greets you. Try: *"Janet, create a task to check the Field Intelligence transcription tomorrow at 10."*
7. Then: *"Call me back in five minutes so we can discuss the Rep Site training issue."* Hang up.
8. **Watch** `https://<host>/admin` → Callbacks: the callback shows `scheduled`, then `dialing`, then `in_progress`. Your phone rings and she opens with the training issue.
9. **Test the failure paths:** don't answer one callback (it retries in 5 minutes), and call from another phone (it's refused).

Then Phase G: connect Google in Dashboard → Integrations, and set `REP_SITE_READ_ENABLED=true`.

## What JANET can do by voice

| Tool | Risk | Notes |
|---|---|---|
| create_task, update_task, list_tasks | low | Marking a task `completed` requires evidence |
| schedule_callback, list_callbacks, cancel_callback | low | Asks before ringing during quiet hours (default 21:00–08:00) |
| remember, search_memory, correct_memory | low | Corrections keep history |
| forget_memory | **sensitive** | Needs your spoken yes; the content is actually erased |
| create_dev_ticket, list_dev_tickets | low | Says plainly that a ticket ≠ work started ≠ fixed |
| calendar_agenda, calendar_check_availability | read | |
| calendar_create_event, calendar_move_event | **sensitive** | Needs your spoken yes |
| rep_site_status | read | Fixed queries, read-only transaction, 8 s timeout, names only (no emails/phones) |
| set_call_preferences | low | Pause calls, briefings on/off, quiet hours |
| end_call | — | |

There is no shell, SQL, deploy, payment, email or SMS tool, and an unknown tool name is rejected and audited.
External data (transcripts, calendar, Rep Site) is fenced as `<data>` in her instructions and treated as
information, never as instructions.

## Daily briefings

Off by default. Turn them on in Dashboard → Settings, or say *"Janet, turn on morning briefings at 8:15."*
Morning covers today's meetings, overdue tasks and open dev tickets, plus Rep Site figures she fetches live.
Evening covers what was completed, what's still open, and tomorrow's meetings. A briefing is skipped when there's
nothing to report, when calls are paused, or on days not selected. Each briefing is queued once per day by
idempotency key.

## Dashboard (`/admin`)

Sections: Overview, Calls, Conversations (summary + transcript), Tasks (create, edit status), Callbacks (schedule a
test call, cancel), Dev tickets, Memory (add, correct, erase), Scheduled jobs, Integrations, Settings and Audit log.
It's mobile-first. Security: password login with a rate limit, a 12-hour signed HttpOnly SameSite=Strict cookie,
a CSRF header on every change, all text HTML-escaped, and no framing.

## Testing

```sh
npm install
# a local Postgres with a database named janet_test (or set DATABASE_URL)
npm test
# Optional: run against Rep Site's real schema
#   createdb repsite_janet; psql -d repsite_janet -f ../../rep-site/tests/db/supabase-shim.sql
#   for f in ../../rep-site/drizzle/migrations/0*.sql; do psql -d repsite_janet -f $f; done
#   psql -d repsite_janet -f ../../rep-site/tests/db/fixtures.sql
REPSITE_TEST_DB=postgres://…/repsite_janet npm test
```

`test/e2e.test.ts` runs the full acceptance flow through the real HTTP/WebSocket server. Twilio requests carry real
signatures (`twilio.getExpectedTwilioSignature`), and the fake OpenAI Realtime server speaks the same event protocol.

## Code map

- `src/index.ts`: startup (migrations, server, worker)
- `src/twilio.ts`: webhooks, caller authorization, outbound calls, the media stream
- `src/realtime.ts`: Twilio ↔ OpenAI audio bridge, barge-in, tool calls, transcripts, reconnect
- `src/context.ts`: persona and per-call context retrieval (memory, tasks, callback source conversation, briefing data)
- `src/tools.ts`: the allowlisted tools, risk levels and confirmation gate
- `src/scheduler.ts`: durable worker (callbacks, retries, quiet hours, pause, briefings, retention, sweeps)
- `src/summarize.ts`: post-call summary and memory extraction
- `src/store.ts`: all database access
- `src/integrations/googleCalendar.ts` and `src/integrations/repSite.ts`
- `src/admin/`: dashboard API and page

## Next steps after the MVP works

1. Move the dashboard into Rep Site as `/manage/janet`. It would read through the RLS policies in migration 002, using Rep Site login instead of a separate password.
2. Rep Site write actions (coaching assignments, bug reports) through Rep Site's existing SECURITY DEFINER RPCs, each with spoken confirmation.
3. A Claude Code runner: approved tickets go to an isolated job queue with scoped credentials, results come back as `fix_proposed`, and deploys always need approval.
4. Semantic memory search (pgvector) once the memory grows past a few hundred items.
