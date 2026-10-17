# 🆘 ReliefLine

**A disaster help desk that runs on WhatsApp. AI listens, translates and triages; humans verify and dispatch.**

> Built for Agentika 2.0 (NaSCon 2026) · Theme: *Human + AI: Better Together* · Deployed on **Alternate Clouds**

In floods, earthquakes and conflicts, cries for help pour into WhatsApp as panicked voice notes in many languages. Volunteers copy them into spreadsheets by hand while people wait. ReliefLine turns each voice note, message and location pin into a translated, prioritised, de-duplicated rescue ticket on a live map. A **human coordinator** then verifies it and dispatches the nearest volunteer, and the person who asked for help is told "help is on the way" in their own language.

## Where the human comes in, and why

The AI transcribes, translates, extracts the need, the people and the location, flags likely duplicates and **suggests** a priority. A human coordinator **verifies every request, confirms or overrides the priority, merges duplicates, rejects false reports and dispatches**. Volunteers accept or decline every task.

Life-or-death triage needs human accountability, local knowledge and protection against false or manipulated requests. No human can listen to 5,000 voice notes in 10 languages, and no AI should decide alone who gets rescued first. Every AI suggestion and every human decision is recorded in the audit log.

## How it works

```
Person in need ──WhatsApp/Telegram (voice · text · 📍)──┐
                                                        ▼
                         ReliefLine on Alternate Clouds (Node.js container)
                           ├─ Groq Whisper   → speech to text, any language
                           ├─ Groq Llama     → need, people, vulnerable, address, suggested priority, translation
                           ├─ OpenStreetMap  → address text → coordinates
                           ├─ Rules          → duplicates within 300 m, nearest available volunteer
                           └─ Live dashboard → map, request cards, audit log, browser simulator
                                                        │
        Coordinator (WhatsApp card or dashboard) ── verifies, sets priority, merges, dispatches
                                                        │
        Volunteer (WhatsApp task + map link) ── Accept / Can't go / Done
                                                        │
        Person in need ◄── "Help is on the way" in their own language
```

**Request lifecycle:** `new` → *(human decision)* → `dispatched` → `accepted` (en route) → `resolved`. A request can also be `waiting` (verified but no volunteer free), `merged` or `rejected`.

**Reliability:**
- **Fails open:** if the AI is down, keyword rules still create the ticket, so no request is ever lost.
- **Idempotent decisions:** a second tap gets "already handled".
- **WhatsApp retries are de-duplicated.**
- **Webhook signatures are verified.**
- **One-at-a-time processing:** state changes are serialised, so there are no races.
- **Declines and no-answers** are re-offered to the next nearest volunteer.
- **Waiting requests** go automatically to the next volunteer who becomes free.
- **Prompt injection:** text inside a message can't skip the human step.
- **Privacy:** phone numbers are masked on the public dashboard.

## Try it (judges)

Open the live link → **Try it** tab → click the map to set a location → send a sample (Urdu, Arabic, Spanish or English), type in any language, or record a **voice note**. Then:
1. Click **Coordinator login** with the demo key from our submission PDF.
2. **Dispatch** the request.
3. Play the demo volunteer (**Accept → Done**).
4. Watch the map, the simulator chat and the **Audit log**.

## Roles on WhatsApp (no app to install)

| Role | How to join | What they do |
|---|---|---|
| Person in need | Message the number | Voice note, text, photo and/or 📍 location |
| Coordinator | `COORDINATOR <code>` | Receives request cards → **Decide**: dispatch P1/P2/P3, merge, ask for info (auto-translated), reject |
| Volunteer | `VOLUNTEER <name>` + share 📍 | Receives tasks with a map link → Accept / Can't go → Done. `AVAILABLE` / `BUSY` / `LEAVE` |

## Deploy on Alternate Clouds

1. Push this repo to GitHub.
2. In [clouds.alternatefutures.ai](https://clouds.alternatefutures.ai): **Add Service** → from the GitHub repo (it builds the `Dockerfile`).
3. **Source tab:** `PORT` = `8000` (it must match, or you get a 502).
4. **Variables tab:** add the variables from [.env.example](.env.example). At minimum: `PORT`, `PUBLIC_URL`, `DASHBOARD_KEY`, `COORDINATOR_CODE`, `GROQ_API_KEY`.
5. **Rebuild**, wait for it to succeed, then **Deploy**. Check the **Logs** tab for `ReliefLine listening on :8000`.
6. Open `https://<your-service>/health` → `{"ok":true}`.

After every code push or variable change: **Rebuild → Deploy**.

### WhatsApp (Meta Cloud API, free test number)
1. [developers.facebook.com](https://developers.facebook.com) → **Create app** (Business) → add **WhatsApp** → **API Setup**.
2. Copy the **temporary access token** into `WHATSAPP_TOKEN` (it lasts about 24h) and the **Phone number ID** into `WHATSAPP_PHONE_NUMBER_ID`.
3. Under **To**, add and verify every demo phone (up to 5): coordinator, volunteer, requester.
4. **WhatsApp → Configuration → Webhook:**
   - Callback URL: `https://<your-service>/webhook/whatsapp`
   - Verify token: the value of `WHATSAPP_VERIFY_TOKEN`
   - Click **Verify and save**, then subscribe to the **messages** field.
5. *(Optional)* App settings → Basic → **App secret** → `WHATSAPP_APP_SECRET`.
6. Each phone sends a first message to the test number. This opens WhatsApp's 24-hour messaging window.

### Telegram (fallback channel, about 2 minutes)
Use [@BotFather](https://t.me/BotFather) → `/newbot` → put the token in `TELEGRAM_BOT_TOKEN`. With `PUBLIC_URL` set, the webhook is registered automatically on start. It has the same roles, commands and buttons.

## Run locally

```bash
node src/server.js          # http://localhost:8000 (Node 22+, no npm install needed)
npm test                    # 17 tests: full rescue loop, overrides, duplicates, idempotency, failover, parsing
```

## Built with
Node.js (zero dependencies) · Groq (Whisper + Llama) · WhatsApp Cloud API · Telegram Bot API · Leaflet + OpenStreetMap / Nominatim · Docker · **Alternate Clouds**

**Third-party credits:** [Leaflet](https://leafletjs.com) (BSD-2), map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), geocoding by Nominatim.

*Demo data only. ReliefLine supports official emergency services (1122 / 112 / 911); it does not replace them.*
