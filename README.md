# CompTIA A+ Practice Exam Simulator (AI-Generated)

Vite + React + TypeScript app that generates each practice session using AI via a secure server-side API route (Vercel).

## Features
- Core selection: 220-1201 or 220-1202
- 90 questions per session + 90-minute timer
- PBQs included (order/match)
- Exam mode: explanations hidden until after submit + review screen
- Analytics: attempt history + weak objectives trendlines

## Local dev
1) Install deps:
```bash
npm install
```

2) Create `.env.local` (serverless functions):
```bash
OPENAI_API_KEY=your_key_here
```

3) Run dev:
```bash
npm run dev
```

## Vercel deploy
- Add an environment variable in Vercel project settings: `OPENAI_API_KEY`
- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`

## Security note
The OpenAI key is used ONLY on the serverless API route (`/api/generate`). It is never shipped to the browser.


## AI controls
- Questions are generated server-side via `/api/generate` using **gpt-4o-mini** (model is enforced on the server).
- Difficulty affects generation constraints:
  - Easy: clearer distractors, simpler scenarios
  - Medium: exam-like balance
  - Hard: closer distractors, more multi-step reasoning

## Rate limiting + caching
`/api/generate` includes:
- Best-effort per-IP rate limiting (in-memory, per warm instance)
- Best-effort response caching (in-memory, 15-minute TTL) keyed by core + plan items + difficulty + generationId + batchIndex

For production-grade consistency across instances, integrate Vercel KV / Upstash and store rate-limit counters + cache entries there.
