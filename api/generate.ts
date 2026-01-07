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

  const contract = [
    "Return STRICT JSON (no markdown, no code fences).",
    "Top-level must be: {\"items\": [...]}",
    "items must have exactly " + items.length + " elements.",
    "Each item MUST include:",
    "- type: one of 'single' | 'multi' | 'pbq-order' | 'pbq-match'",
    "- domain: string (e.g., '1.0 Mobile Devices')",
    "- objectiveId: string (e.g., '1.1')",
    "- objectiveTitle: string",
    "- objectiveBullets: string[]",
    "- prompt: string",
    "- explanation: string",
    "",
    "Type-specific fields:",
    "- single/multi: options: string[4..6], correctIndices: int[1..3] (0-based, within options length)",
    "- pbq-order: orderItems: string[4..8], correctOrder: int[] (0-based permutation same length as orderItems)",
    "- pbq-match: left: string[3..8], right: string[3..8], correctPairs: {leftIndex:int,rightIndex:int}[]",
    "",
    "Do not include any additional top-level keys besides 'items'.",
  ].join("\n");

  const baseSystem = [
    "You are a CompTIA A+ (220-1201 / 220-1202) item writer.",
    "Write ORIGINAL practice questions aligned to the provided objective. Do NOT reproduce copyrighted exam content.",
    "Keep prompts concise and realistic (help-desk / technician scenarios).",
    "Difficulty rules:",
    "- easy: straightforward, minimal ambiguity; distractors clearly wrong; no tricky wording.",
    "- medium: exam-like; moderate scenario detail; plausible distractors; one clear best answer.",
    "- hard: deeper reasoning within the objective; closer distractors; multi-step scenarios; avoid trick questions.",
    "",
    "Output format requirements:",
    contract,
  ];

  const userPayload = {
    purpose: "Generate a batch of CompTIA A+ practice questions.",
    difficulty,
    items: items.map((it) => ({
      type: it.type,
      domain: `${it.domainNumber} ${it.domainLabel}`.trim(),
      objectiveId: it.objectiveId,
      objectiveTitle: it.objectiveTitle,
      objectiveBullets: it.objectiveBullets,
    })),
  };

  function extractJsonObject(text: string) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) {
      throw new Error("Model did not return a JSON object.");
    }
    const slice = text.slice(first, last + 1);
    return JSON.parse(slice);
  }

  function validateBatch(obj: any) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("Top-level JSON must be an object.");
    const keys = Object.keys(obj);
    if (!(keys.length === 1 && keys[0] === "items")) throw new Error("Top-level must contain only 'items'.");
    if (!Array.isArray(obj.items)) throw new Error("'items' must be an array.");
    if (obj.items.length !== items.length) throw new Error(`'items' length ${obj.items.length} !== expected ${items.length}.`);

    for (const q of obj.items) {
      if (!q || typeof q !== "object") throw new Error("Each item must be an object.");
      const reqBase = ["type", "domain", "objectiveId", "objectiveTitle", "objectiveBullets", "prompt", "explanation"];
      for (const k of reqBase) {
        if (!(k in q)) throw new Error(`Missing required field '${k}'.`);
      }
      if (!["single", "multi", "pbq-order", "pbq-match"].includes(q.type)) throw new Error("Invalid type.");
      if (!Array.isArray(q.objectiveBullets)) throw new Error("objectiveBullets must be an array of strings.");

      if (q.type === "single" || q.type === "multi") {
        if (!Array.isArray(q.options) || q.options.length < 4 || q.options.length > 6) throw new Error("options must be 4..6 strings.");
        if (!Array.isArray(q.correctIndices) || q.correctIndices.length < 1 || q.correctIndices.length > 3) throw new Error("correctIndices must be 1..3 integers.");
      } else if (q.type === "pbq-order") {
        if (!Array.isArray(q.orderItems) || q.orderItems.length < 4 || q.orderItems.length > 8) throw new Error("orderItems must be 4..8 strings.");
        if (!Array.isArray(q.correctOrder) || q.correctOrder.length !== q.orderItems.length) throw new Error("correctOrder length must match orderItems length.");
      } else if (q.type === "pbq-match") {
        if (!Array.isArray(q.left) || q.left.length < 3 || q.left.length > 8) throw new Error("left must be 3..8 strings.");
        if (!Array.isArray(q.right) || q.right.length < 3 || q.right.length > 8) throw new Error("right must be 3..8 strings.");
        if (!Array.isArray(q.correctPairs) || q.correctPairs.length < 1) throw new Error("correctPairs must be a non-empty array.");
      }
    }
    return obj.items as any[];
  }

  const endpoint = "https://api.openai.com/v1/responses";

  let lastErr: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const system = [...baseSystem];
    if (attempt === 1 && lastErr) {
      system.push("", "Your previous output was invalid.", `Fix the JSON and re-output per contract. Error: ${String(lastErr).slice(0, 500)}`);
    }

    const body = {
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: system.join("\n") }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(userPayload) }] },
      ],
      temperature: 0.6,
      max_output_tokens: 3500,
    };

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`OpenAI error ${resp.status}: ${errText || resp.statusText}`);
    }

    const data: any = await resp.json();

    // Extract text from Responses output
    let text = "";
    if (typeof data.output_text === "string") {
      text = data.output_text;
    } else if (Array.isArray(data.output)) {
      for (const o of data.output) {
        const content = o?.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type === "output_text" && typeof c.text === "string") text += c.text;
          }
        }
      }
    }

    try {
      const obj = extractJsonObject(text);
      const itemsOut = validateBatch(obj);
      return itemsOut;
    } catch (e: any) {
      lastErr = e?.message || String(e);
    }
  }

  throw new Error(`Model returned invalid JSON after retries: ${String(lastErr)}`);
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

