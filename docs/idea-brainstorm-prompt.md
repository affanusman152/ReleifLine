# Brainstorm brief: one winning hackathon idea

You are helping a 2-person student team choose **one** idea to build and deploy **in about 5 hours** at a hackathon. Read every constraint and think hard. A brilliant idea we can't finish loses to a good idea that works end to end.

---

## 1. The event

- **Event:** Agentika 2.0, an AI automation hackathon at NaSCon, FAST University, Islamabad, Pakistan.
- **Team:** 2 university students, laptops only, no hardware.
- **Theme:** **Human + AI: Better Together**
- **Time left:** about 9 hours to the hard deadline, which leaves about **5 hours of real build time** after setup, deployment, the demo video and the submission PDF.
- **Judges:** Grayhat (a Pakistani software company) and Alternate Futures (a cloud/AI infrastructure sponsor).

## 2. Hard constraints (non-negotiable)

1. **It must be deployed on Alternate Clouds** (a container cloud; it runs Docker apps and n8n templates). Local-only demos or hosting anywhere else means disqualification.
2. **Stack:** n8n workflows, custom code (Python/FastAPI or Node), or both. Free or cheap AI APIs only, e.g. **Groq** (fast free LLMs such as Llama), Gmail/Telegram/WhatsApp/Slack integrations, public APIs, and MCP where it fits.
3. **There must be a real human-in-the-loop step:** a point where a human **judges, approves, edits or decides**, and the reason it must be a human has to be obvious. This must be **central** to the product, not bolted on.
4. **It must be demoable live in 6 minutes and in a 2–3 minute video.** The judges must see the end-to-end flow actually run.
5. **No paid data, no scraping that needs special access, no hardware, no app-store publishing.**
6. Everything must work with **sample/demo data** we can create ourselves in minutes.

## 3. Judging rubric (100 points)

| Points | Criterion | What the judges ask |
|---|---|---|
| **25** | Technical execution & reliability | Does it work end to end? Are integrations reliable? Are errors and edge cases handled? |
| **20** | Usefulness & real-world impact | Does it solve a genuine problem with practical value? |
| **15** | Theme alignment | Is "Human + AI: Better Together" **central**, not an afterthought? |
| **15** | Creativity & uniqueness | Is it different from generic AI wrappers and existing products? |
| **15** | Automation depth & integration | Are agents, APIs, automation tools and MCP used to make one coherent workflow? |
| **10** | UX & presentation | Is it easy to use, and is its value clear in a demo? |

## 4. What we want

An idea that:

- solves a problem **real people in Pakistan (or similar developing-world contexts) actually have and are underserved on**: citizens, students, small businesses, clinics, NGOs, farmers, workers, local government, etc.
- is **not** a generic "chat with your PDF", "AI resume screener", "AI email writer", "AI tutor chatbot", or "summarise my meetings" app. The judges will have seen dozens of those.
- uses AI for the **heavy, repetitive, scalable** part and the human for the **judgment, empathy, accountability or local knowledge** part. The split should feel *natural*, not forced.
- has a **"wow" moment** in the demo, e.g. a message arriving on a phone, an approval button that triggers real action, or a messy real-world input turned into a clean decision.
- can tell a **clear story in one sentence:** "For [who], who struggle with [problem], we [do X with AI] and let [human] [decide Y], so that [outcome]."

## 5. What I want from you

### Step A: Generate 10 ideas
For each idea give:
1. **Name** and **one-line pitch**
2. **Who it serves** and **the problem** (2 lines, with concrete evidence of why it's a real need)
3. **The AI part:** what the AI automates
4. **The human part:** exactly which step needs a human and **why a human must do it**
5. **Workflow sketch:** trigger → steps → human checkpoint → action (5–8 steps, naming the concrete tools/nodes/APIs)
6. **Demo moment:** what the judges will see that makes them go "oh, nice"
7. **Build risk:** what could break or eat time
8. **Rubric score estimate** out of 100, broken down by the six criteria
9. **Feasibility in 5 hours for 2 students:** High / Medium / Low

### Step B: Red-team them
Be harsh. For each idea say in one line why it might **lose**: too generic, too big, a weak human step, hard to demo, or it already exists.

### Step C: Pick the winner
Choose the **single best idea**, balancing score against feasibility, and give:
- why it beats the others
- the **minimum viable scope** (what to build in the first 3 hours)
- **stretch features** (only if time remains)
- an **hour-by-hour build plan** for 5 hours, split between 2 people
- the **architecture** (n8n nodes and/or code services, data storage, AI model, integrations), and how it runs as a container on Alternate Clouds
- the **sample data** we need to create for the demo
- the **edge cases** to handle so the "reliability" score is high
- the **6-minute live demo script** (what to click and say, minute by minute)
- one sentence for **"Where the human comes in, and why"** (this goes straight into our submission form)

## 6. Output rules

- Be concrete. Name real tools, real n8n nodes and real APIs, not "use AI to analyze".
- Prefer ideas that run on **Groq + n8n + a messaging channel (Telegram/Gmail/WhatsApp)**, because that path is fastest to deploy.
- Don't propose anything that needs data we can't get or fake in 15 minutes.
- Keep it scannable: headings, tables and bullets.
