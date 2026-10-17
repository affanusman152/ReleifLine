# InvoiceGuard: build spec (WhatsApp edition)

**Pitch:** For the millions of small businesses worldwide that run on WhatsApp instead of accounting software, InvoiceGuard reads any supplier bill (any language, any currency, even handwritten), checks it against past purchases, and flags overcharges and duplicates. **Only the owner can approve or reject a bill.** Every decision the owner makes teaches the system what "normal" looks like next time.

**Who it's for (global):** small shops, restaurants, clinics, workshops and traders in any country who get bills as photos in a chat, not as e-invoices in an ERP. This includes South Asia, Latin America, Africa, the Middle East and Southern Europe, where WhatsApp *is* the business channel. Existing invoice tools (QuickBooks, Xero, enterprise AP software) assume clean PDFs, accounting knowledge and a desktop. These businesses have none of those.

**Theme line (submission form):** *Where the human comes in, and why:* the owner approves or rejects every bill and approves any dispute message before it goes to a supplier. Only the owner carries the supplier relationship, the cash-flow reality and the legal responsibility for the money. The AI does the reading and comparing, and the human makes the call. Each approval also updates the baseline the AI checks against, so the system gets smarter from human judgment.

---

## 1. What changed from v1 (and why)

| Change | Why it scores |
|---|---|
| **WhatsApp instead of Telegram** | WhatsApp is the default business channel across most of the world. No app to install and no onboarding → **Usefulness, global reach** |
| **Any language, any currency, handwritten bills** (vision model) | Reads a Spanish, Arabic, Urdu or English bill, printed or handwritten, and replies in English. Generic tools need clean PDFs → **Creativity, global reach** |
| **Human decisions feed back into history** (an approved price becomes the new baseline, and the owner's note is stored with it) | Human and AI genuinely improve each other → **Theme** |
| **On reject, the AI drafts a polite dispute message → owner approves → it's sent to the supplier's WhatsApp** | A second human checkpoint, a real action, and a live "wow" on a second phone → **Automation depth, Demo** |
| **Rules are deterministic code; the LLM only extracts and phrases** | Flags are predictable and testable → **Reliability (25 pts)** |
| **Images first, text-PDFs second, scanned PDFs → "send a photo"** | Cuts scope that would eat hours |

---

## 2. Architecture

```
Owner's WhatsApp ──► Meta WhatsApp Cloud API (free test number)
                         │  webhook (HTTPS)
                         ▼
        n8n container on Alternate Clouds  ──► Groq (vision + text LLM)
                         │
                         ▼
                 Google Sheets (history, pending, approved, rejected, vendors)
                         │
                         ▼
        WhatsApp replies: owner (approval buttons) / supplier (dispute msg)
```

- **n8n**: the Alternate Clouds n8n template. Env vars: `N8N_ENCRYPTION_KEY` (32 characters, never change it) and `WEBHOOK_URL=https://<service-name>-app.alternatefutures.ai`.
- **WhatsApp**: a Meta for Developers app with the WhatsApp product, which gives a **free test number**. You can message **up to 5 verified recipient numbers**: add the owner's phone and the "supplier" (your teammate's phone).
- **Groq**: a vision model for photos and a text model for PDFs and dispute drafts. Check current model IDs at console.groq.com/docs/models (look for a Llama 4 Scout/Maverick vision model). Use `response_format: {"type":"json_object"}`.
- **Google Sheets**: auth with a **Service Account** (create it in Google Cloud, share the sheet with its email). This is faster than OAuth on self-hosted n8n.
  - *Fallback if Google auth fights you:* n8n's built-in **Data Tables**.

---

## 3. Google Sheet: `InvoiceGuard`

| Tab | Columns |
|---|---|
| **History** | vendor, item, unit_price, qty, invoice_no, date, source (`seed` / `approved`), owner_note |
| **Pending** | invoice_id, vendor, invoice_no, date, total, items_json, flags_json, received_at, status |
| **Approved** | invoice_id, vendor, invoice_no, total, flags, owner_note, decided_at |
| **Rejected** | invoice_id, vendor, invoice_no, total, flags, reason, dispute_sent (Y/N), decided_at |
| **Vendors** | vendor, whatsapp_number (the teammate's number for the demo) |
| **State** | owner_number, last_invoice_id, awaiting (`note` / `dispute_approval` / none) |

**Seed data (15 min):** add 8–10 History rows for 2 vendors (e.g. *Al-Madina Traders*: A4 ream 420, toner 1300; *Khan Cleaning Supplies*: floor cleaner 850, mop 600).

---

## 4. The n8n workflow (ONE workflow, stateless)

Every WhatsApp event hits one trigger, and a **Switch** routes it. State lives in Sheets, not in n8n "Wait" nodes, which is more robust if the container restarts.

```
WhatsApp Trigger (messages)
 └─ Code: allow-list check (sender ∈ owner/vendor numbers) → else ignore
 └─ Switch on message type
     ├─ image / document  → [A] Process invoice
     ├─ interactive (button_reply) → [B] Handle decision
     └─ text → [C] Note / help
```

### [A] Process invoice
1. **Reply right away:** "🔍 Checking your bill…" so the user knows it was received.
2. **Download the media.** Use the WhatsApp node's media download, or two HTTP requests: `GET graph.facebook.com/v{ver}/{media_id}` → `url`, then `GET url` with a Bearer token → binary. *The media URL expires in about 5 minutes, so download immediately.*
3. **Branch on type:**
   - image → base64 → Groq **vision**
   - PDF → **Extract from File** (PDF) → if the text is empty, reply "Please send this as a photo" and stop; else → Groq **text**
4. **Groq extraction** (prompt in §6). Pass the **list of known item names for known vendors** so the model maps "A-4 paper" → "A4 ream".
5. **Code: validate JSON.** If parsing fails, retry once; if it fails again → "Couldn't read this bill clearly. Please send a clearer photo."
6. **Sheets: read History** for this vendor.
7. **Code: rules** (§5) → `flags[]` with a severity of 🔴 or 🟡.
8. **Sheets: append Pending** with `invoice_id = INV-<timestamp>`.
9. **WhatsApp: interactive message** with up to 3 reply buttons:
   - `✅ Approve` → id `approve|<invoice_id>`
   - `❌ Reject` → id `reject|<invoice_id>`
   - `📝 Approve + note` → id `note|<invoice_id>`
   - The body has a **1024-character limit**, so show the top 5 items and "+N more".

### [B] Handle decision (button reply)
- Parse `action|invoice_id` → look the invoice up in Pending (if it's not found or already decided → "Already handled ✔").
- **approve** → append Approved → **append its items to History with `source=approved`** (the learning loop) → mark Pending as done → "✅ Approved. Saved to records."
- **note** → set State `awaiting=note` → "Type your note (e.g. 'higher price ok, rush order')." → [C] saves it and then approves.
- **reject** → append Rejected → Groq drafts a short, polite dispute message to the vendor that cites the flags → send the draft to the owner with buttons `📤 Send to supplier` (`send|id`) and `🚫 Don't send` (`nosend|id`).
- **send** → WhatsApp text to the vendor's number from the Vendors tab → mark `dispute_sent=Y` → "📤 Sent to Al-Madina Traders."

### [C] Text
- If State says `awaiting=note` → save the note to the invoice + History rows → approve.
- Otherwise → help text: "Send me a photo of any supplier bill and I'll check it for you."
- *(Stretch)* Questions like "How much did I spend with Al-Madina this month?" → Groq over the History rows.

---

## 5. Anomaly rules (Code node: deterministic)

| Rule | Flag |
|---|---|
| Unit price > last approved price of the same item by **>15%** | 🔴 "Toner: 1,300 → 1,590 (+22%)" |
| Same vendor + same invoice_no already in Approved/Pending | 🔴 "Possible duplicate of INV… approved on …" |
| \|sum(line totals) − grand_total\| > 1 | 🔴 "Lines add up to 12,200 but the bill says 12,450" |
| qty × unit_price ≠ line total | 🟡 "Line math wrong: 5 × 1,590 ≠ 8,200" |
| Currency differs from this vendor's past bills | 🔴 "Billed in USD, but past bills were in AED" (only compare prices in the same currency) |
| Vendor not in History | 🟡 "New supplier, no history to compare" |
| Item not seen before from this vendor | 🟡 "New item: Stapler" |
| `confidence < 0.75` or missing total/vendor | 🟡 "Low read confidence, please double-check" |
| No flags | 🟢 "Matches past prices. Looks good." |

---

## 6. Groq extraction prompt

```
You extract data from supplier bills/invoices sent by small businesses anywhere in the world.
Bills may be printed or handwritten, in any language or script, and in any currency.
Detect the currency from symbols/text (₨, Rs, $, €, £, AED, ₹, R$, ₦ ...) and output its ISO 4217 code.

Known items for known vendors (use these exact names when an item clearly matches):
{{ known_items_json }}

Return ONLY JSON:
{
  "is_invoice": true,
  "vendor": string|null,
  "invoice_number": string|null,
  "date": "YYYY-MM-DD"|null,
  "currency": "ISO 4217 code"|null,
  "language": "detected language name",
  "line_items": [{"item": string, "item_original": string, "qty": number, "unit_price": number, "total": number}],
  "grand_total": number|null,
  "confidence": number between 0 and 1
}
Rules: never invent values; use null if unreadable. If this is not a bill, set is_invoice=false.
"item" is the English name; "item_original" is exactly as written on the bill.
Numbers must be plain numbers (handle both 1,234.50 and 1.234,50 formats correctly).
```

**Dispute draft prompt:** "Write a short, polite WhatsApp message from {{owner_business}} to {{vendor}} about invoice {{no}}. Mention these issues: {{flags}}. Ask them to confirm or send a corrected bill. Max 60 words. English."

---

## 7. Edge cases (say these out loud in the demo)

| Situation | Behaviour |
|---|---|
| Blurry / unreadable | Ask for a clearer photo; nothing is saved |
| Not a bill (selfie, meme) | "This doesn't look like a bill." |
| Groq timeout / 429 | Retry once → "AI is busy, please resend in a minute." |
| Invalid JSON from the LLM | Retry once with "return valid JSON only" |
| Button pressed twice | "Already handled ✔" (idempotent) |
| Unknown sender | Ignored (allow-list) |
| Scanned PDF with no text | "Please send it as a photo." |
| Owner never replies | Stays in Pending, **never auto-approved** |
| Several images in one message | Each image is a separate WhatsApp message → each is processed separately |

---

## 8. WhatsApp gotchas (read before starting)

- **Meta allows one webhook URL per app.** n8n's test URL and production URL differ, so **activate the workflow** and debug from the **Executions** list instead of "Test workflow".
- **The 24-hour window:** you can only send free-form messages to a number that messaged *you* in the last 24h. **Before the demo, have the supplier phone send "hi" to the bot.**
- **The temporary access token lasts about 24h.** Generate it at the start and store it in the n8n credential, not in code.
- Every recipient number must be **added and verified** in the Meta dashboard (OTP).
- **⏱ Timebox:** if an image sent from your phone doesn't reach n8n **within 60 minutes of starting**, switch the channel to Telegram. Everything after the trigger stays the same.

---

## 9. Build plan (2 people)

| Time | Person A (pipeline) | Person B (channel + data) |
|---|---|---|
| **3:45–4:45** | Deploy the n8n template on Alternate Clouds with both env vars. Groq key. | Meta app + WhatsApp test number, verify both phones. Google Sheet + service account + seed data. |
| **4:45–5:15** | **GATE:** a photo sent on WhatsApp → n8n replies "Checking…". Otherwise fall back to Telegram. | |
| **5:15–6:45** | Download media → Groq extraction → validate JSON | Rules Code node + Pending append + interactive buttons |
| **6:45–8:00** | Decision branch: approve / reject / note + learning loop | Dispute draft + send to supplier + Vendors lookup |
| **8:00–9:00** | Edge cases + retries + "already handled" | Make 6 test bills (incl. 1 handwritten) and run all of them |
| **9:00** | **Feature freeze.** Export the workflow JSON to the repo. | Demo video recording |
| **9:00–12:00** | LinkedIn post (written yourselves), screenshots, submission PDF. Submit by 12:00. | |

**Test bills:** ① clean match (🟢) ② price hike +25% ③ duplicate number ④ new vendor ⑤ totals don't add up ⑥ handwritten bill ⑦ **a bill in another language and currency** (e.g. Spanish in EUR or Arabic in AED; make it in Google Docs in 5 min).
Test ⑥ and ⑦ with Groq **early**. If one reads badly, keep it out of the live demo and say "works best on printed bills".

---

## 10. 6-minute demo

Put **WhatsApp Web on the projector** as the owner, and have your teammate hold the "supplier" phone.

| Time | Do / say |
|---|---|
| 0:00–0:40 | "Millions of small businesses worldwide run on WhatsApp, not accounting software. Bills arrive as photos, and overcharges and duplicates slip through. Here's InvoiceGuard." |
| 0:40–1:00 | Show the History sheet: what we normally pay Al-Madina. |
| 1:00–2:10 | Send the **clean bill** → 🟢 → tap Approve → the row appears in Approved. |
| 2:10–3:40 | Send the **overcharged bill** → 🔴 "Toner +22%" → tap **Reject** → the AI drafts a dispute → owner taps **Send** → **the supplier's phone buzzes live.** |
| 3:40–4:10 | Send the **same bill again** → 🔴 "Possible duplicate". |
| 4:10–4:50 | Send a **Spanish bill in EUR** → it's read and summarised in English with the right currency. "Same product in São Paulo, Dubai or Lagos. No setup, just WhatsApp." |
| 4:50–5:30 | "The AI reads and compares; the owner decides. Nothing is paid or sent without a human tap, and every approval updates what the AI considers normal." |
| 5:30–6:00 | Architecture in one line: WhatsApp → n8n on **Alternate Clouds** → Groq → Sheets. |

---

## 11. Stretch (only after the 9:00 freeze checklist is green)
- "How much did I spend with X this month?" Q&A in WhatsApp
- A weekly summary message: approved total, flagged amount, money saved
- A Dashboard tab in Sheets with a chart of flagged vs. approved
