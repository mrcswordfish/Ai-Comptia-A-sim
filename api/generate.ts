import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash } from "crypto";

type Difficulty = "easy" | "medium" | "hard";

type PlanItem = {
  domainNumber: string;
  domainLabel: string;
  objectiveId: string;
  objectiveTitle: string;
  objectiveBullets: string[];
  type: "single" | "multi" | "pbq-order" | "pbq-match";
};

function json(res: VercelResponse, status: number, body: any) {
  res.status(status).setHeader("Content-Type", "application/json").send(JSON.stringify(body));
}

function safeArray(x: any): any[] {
  return Array.isArray(x) ? x : [];
}


// --------- Best-effort in-memory cache + rate limiting (serverless-safe enough for MVP) ---------
// NOTE: In-memory state persists per warm lambda instance, but is not shared across instances.
// For production-grade rate limiting/caching, use Vercel KV / Upstash / Redis.

type CacheEntry<T> = { expiresAt: number; value: T };

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const RATE_WINDOW_MS = 60 * 1000; // 60 seconds
const RATE_LIMIT = 30; // requests per IP per window (tune as needed)

const cache: Map<string, CacheEntry<any>> = ((globalThis as any).__A_CACHE__ ??= new Map());
const rate: Map<string, { resetAt: number; count: number }> = ((globalThis as any).__A_RATE__ ??= new Map());

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

function cacheGet<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value as T;
}

function cacheSet<T>(key: string, value: T) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function getClientIp(req: VercelRequest): string {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0].trim();
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.length > 0) return real.trim();
  // @ts-ignore
  return (req.socket?.remoteAddress as string) || "unknown";
}

function enforceRateLimit(req: VercelRequest, res: VercelResponse): boolean {
  const ip = getClientIp(req);
  const now = Date.now();
  const cur = rate.get(ip);

  if (!cur || now > cur.resetAt) {
    rate.set(ip, { resetAt: now + RATE_WINDOW_MS, count: 1 });
    res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT));
    res.setHeader("X-RateLimit-Remaining", String(RATE_LIMIT - 1));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil((now + RATE_WINDOW_MS) / 1000)));
    return true;
  }

  if (cur.count >= RATE_LIMIT) {
    const retry = Math.max(1, Math.ceil((cur.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retry));
    res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT));
    res.setHeader("X-RateLimit-Remaining", "0");
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(cur.resetAt / 1000)));
    json(res, 429, { error: "Rate limit exceeded. Please wait and retry.", retryAfterSeconds: retry });
    return false;
  }

  cur.count += 1;
  rate.set(ip, cur);
  res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, RATE_LIMIT - cur.count)));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(cur.resetAt / 1000)));
  return true;
}
async function callOpenAI(model: string, items: PlanItem[], difficulty: Difficulty) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY (set it in Vercel project environment variables).");

  // JSON schema for strict structured output
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        minItems: items.length,
        maxItems: items.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            // discriminator
            type: { type: "string", enum: ["single", "multi", "pbq-order", "pbq-match"] },

            // objective tagging
            domain: { type: "string" },
            objectiveId: { type: "string" },
            objectiveTitle: { type: "string" },
            objectiveBullets: { type: "array", items: { type: "string" } },

            // stem + rationale
            prompt: { type: "string" },
            explanation: { type: "string" },

            // MCQ / multi-select
            options: { type: "array", minItems: 4, maxItems: 6, items: { type: "string" } },
            correctIndices: { type: "array", minItems: 1, maxItems: 3, items: { type: "integer", minimum: 0, maximum: 5 } },

            // PBQ order
            orderItems: { type: "array", minItems: 4, maxItems: 8, items: { type: "string" } },
            correctOrder: { type: "array", minItems: 4, maxItems: 8, items: { type: "integer", minimum: 0, maximum: 7 } },

            // PBQ match
            leftLabel: { type: "string" },
            rightLabel: { type: "string" },
            left: { type: "array", minItems: 3, maxItems: 6, items: { type: "string" } },
            right: { type: "array", minItems: 3, maxItems: 6, items: { type: "string" } },
            correctPairs: {
              type: "array",
              minItems: 3,
              maxItems: 6,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  leftIndex: { type: "integer", minimum: 0, maximum: 5 },
                  rightIndex: { type: "integer", minimum: 0, maximum: 5 }
                },
                required: ["leftIndex", "rightIndex"]
              }
            }
          },
          required: ["type", "domain", "objectiveId", "objectiveTitle", "objectiveBullets", "prompt", "explanation"]
        }
      }
    },
    required: ["items"]
  };

  const system = [
    "You are a CompTIA A+ (220-1201 / 220-1202) item writer.",
    "Write ORIGINAL practice questions aligned to the provided objective. Do NOT reproduce copyrighted exam content.",
    "Keep prompts concise and realistic (help-desk / technician scenarios).",
    "Difficulty rules:",
    "Output rules per type:",
    "- single: include options (4-6) and correctIndices with exactly 1 index.",
    "- multi: include options (4-6) and correctIndices with 2-3 indices.",
    "- pbq-order: include orderItems (4-8) and correctOrder as index order over orderItems.",
    "- pbq-match: include leftLabel/rightLabel, left/right lists, and correctPairs (index pairs).",
    "- easy: straightforward, minimal ambiguity; distractors clearly wrong; no tricky wording.",
    "- medium: exam-like; moderate scenario detail; plausible distractors; one clear best answer.",
    "- hard: deeper reasoning within the objective; closer distractors; multi-step scenarios; avoid trick questions.",
    "For single-choice: exactly 4 options and exactly 1 correct index.",
    "For multi-select: exactly 4 options and 2-3 correct indices.",
    "For PBQs:",
    "- pbq-order: provide 4-7 steps and a correctOrder that references orderItems indices in correct sequence.",
    "- pbq-match: provide left/right lists and correctPairs mapping leftIndex->rightIndex.",
    "Return strictly valid JSON matching the schema."
  ].join("\n");

  const user = {
    purpose: "Generate a batch of CompTIA A+ practice questions.",
    difficulty,
    items: items.map((it) => ({
      type: it.type,
      domain: `${it.domainNumber} ${it.domainLabel}`,
      objectiveId: it.objectiveId,
      objectiveTitle: it.objectiveTitle,
      objectiveBullets: it.objectiveBullets.slice(0, 20)
    }))
  };

  const body = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "a_plus_question_batch",
        strict: true,
        schema: schema
      }
    }
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OpenAI error ${resp.status}: ${errText || resp.statusText}`);
  }

  const data: any = await resp.json();

  // Extract JSON text safely from Responses output
  let text = "";
  if (typeof data.output_text === "string") {
    text = data.output_text;
  } else if (Array.isArray(data.output)) {
    for (const o of data.output) {
      const content = o?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === "string") {
            text += c.text;
          } else if (typeof c?.output_text === "string") {
            text += c.output_text;
          }
        }
      }
    }
  }

  // Some structured responses may include parsed JSON directly
  if (!text && data?.output?.[0]?.content?.[0]?.text) text = data.output[0].content[0].text;

  const parsed = typeof data?.output?.[0]?.content?.[0]?.parsed === "object" ? data.output[0].content[0].parsed : null;

  const jsonObj = parsed ?? (text ? JSON.parse(text) : null);
  if (!jsonObj?.items) throw new Error("Model returned no items.");
  return jsonObj.items;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
  if (!enforceRateLimit(req, res)) return;

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body as any);

    const model = "gpt-4o-mini"; // locked per app requirements
    const core = String(body?.core || "");
    const generationId = typeof body?.generationId === "string" ? body.generationId : null;
    const batchIndex = typeof body?.batchIndex === "number" ? body.batchIndex : null;

    const diffRaw = String(body?.difficulty || "medium") as Difficulty;
    const diff: Difficulty = (diffRaw === "easy" || diffRaw === "medium" || diffRaw === "hard") ? diffRaw : "medium";

    const items = safeArray(body?.items) as PlanItem[];

    if (!core) return json(res, 400, { error: "Missing core." });
    if (!items.length) return json(res, 400, { error: "No items provided." });
    if (items.length > 20) return json(res, 400, { error: "Too many items in one request; batch <= 20." });

    // Minimal validation
    for (const it of items) {
      if (!it.objectiveId || !it.objectiveTitle) throw new Error("Invalid plan item (missing objective).");
      if (!it.type) throw new Error("Invalid plan item (missing type).");
    }

    const cacheKey = sha256(
      JSON.stringify({
        core,
        items,
        diff,
        generationId,
        batchIndex,
      })
    );

    const cached = cacheGet<any[]>(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return json(res, 200, { items: cached, cached: true });
    }

    const generated = await callOpenAI(model, items, diff);
    cacheSet(cacheKey, generated);
    res.setHeader("X-Cache", "MISS");
    return json(res, 200, { items: generated, cached: false });
  } catch (e: any) {
    return json(res, 500, { error: e?.message || String(e) });
  }
}

