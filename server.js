require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const OpenAI = require("openai");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

const groq = process.env.GROQ_API_KEY
  ? new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    })
  : null;a

const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const GROQ_MODEL = "openai/gpt-oss-20b";
const GEMINI_FALLBACK_MODELS = [
  "gemini-3.8-flash",
  "gemini-4-hydrogen",
  "gemini-3.5-flash-lite",
];
const GEMINI_IMAGE_MODELS = [
  "gemini-nano-banana-2.1",
  "gemini-3.1-flash-image",
];

const KOVA_SYSTEM_PROMPT = `
You are Kova, a fast, deeply analytical multimodal AI assistant and workspace companion.
You help users think deeply, analyze shared screens, read and edit files, manage tasks, remember user info, enhance prompts, and create images.
Rules:
- Reply naturally in the user's selected language.
- Be clear, accurate, structured, and practical with no fluff.
- When given a screen capture or file, inspect every detail carefully before answering.
`.trim();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateWithGeminiFallback(parts, thinkingLevel = "HIGH") {
  let lastErr = null;
  for (const modelName of GEMINI_FALLBACK_MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const resp = await gemini.models.generateContent({
          model: modelName,
          contents: [{ role: "user", parts }],
          config: {
            thinkingConfig: { thinkingLevel },
          },
        });
        return { text: resp.text || "Completed.", modelUsed: modelName };
      } catch (err) {
        lastErr = err;
        const status = err?.status || 0;
        if (status === 503 || status === 429) {
          await sleep(700 * attempt);
          continue;
        }
        break;
      }
    }
  }
  throw lastErr || new Error("All Gemini models temporarily unavailable.");
}

async function generateWithAiHorde(prompt) {
  const submitResp = await fetch("https://aihorde.net/api/v2/generate/async", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: "0000000000",
      "Client-Agent": "KovaAI:1.0:kova",
    },
    body: JSON.stringify({
      prompt,
      params: { width: 512, height: 512, steps: 20 },
      nsfw: false,
      censor_nsfw: true,
    }),
  });
  if (!submitResp.ok) {
    throw new Error(`AI Horde submit HTTP ${submitResp.status}`);
  }
  const { id } = await submitResp.json();
  if (!id) throw new Error("AI Horde did not return a job ID");

  for (let i = 0; i < 20; i++) {
    await sleep(2500);
    const checkResp = await fetch(`https://aihorde.net/api/v2/generate/status/${id}`, {
      headers: { "Client-Agent": "KovaAI:1.0:kova" },
    });
    if (!checkResp.ok) continue;
    const statusData = await checkResp.json();
    if (statusData.done && Array.isArray(statusData.generations) && statusData.generations[0]?.img) {
      const imgUrlOrB64 = statusData.generations[0].img;
      if (imgUrlOrB64.startsWith("http")) {
        const imgFetch = await fetch(imgUrlOrB64);
        const buf = Buffer.from(await imgFetch.arrayBuffer());
        return `data:image/webp;base64,${buf.toString("base64")}`;
      }
      return `data:image/webp;base64,${imgUrlOrB64}`;
    }
  }
  throw new Error("AI Horde queue timed out");
}

app.post("/api/chat", async (req, res) => {
  try {
    const {
      message = "",
      mode = "deep",
      language = "English (US)",
      memory = [],
      tasks = [],
      fileContext = null,
      screenImageBase64 = null,
      history = [],
    } = req.body;

    if (!String(message).trim() && !screenImageBase64 && !fileContext) {
      return res.status(400).json({ error: "Please enter a message or share screen/file context." });
    }

    const contextBlock = [
      `Active Language: ${language}`,
      Array.isArray(memory) && memory.length
        ? `Saved User Memory:\n${memory.map((m) => `- ${m}`).join("\n")}`
        : "",
      Array.isArray(tasks) && tasks.length
        ? `User Tasks:\n${tasks.map((t) => `- [${t.done ? "DONE" : "OPEN"}] ${t.title}`).join("\n")}`
        : "",
      fileContext && fileContext.content
        ? `Workspace File (${fileContext.name || "untitled"}):\n${String(fileContext.content).slice(0, 12000)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const fullUserPrompt = `${contextBlock}\n\nUser Request:\n${message}`;

    const safeHistory = Array.isArray(history)
      ? history
          .slice(-8)
          .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
      : [];

    if (mode === "fast" && !screenImageBase64 && groq) {
      const completion = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: KOVA_SYSTEM_PROMPT },
          ...safeHistory,
          { role: "user", content: fullUserPrompt },
        ],
        temperature: 0.3,
        max_tokens: 1200,
      });

      return res.json({
        reply: completion.choices?.[0]?.message?.content || "Done.",
        engine: "Kova Fast (Groq)",
      });
    }

    let groqDraft = "";
    if (groq && !screenImageBase64) {
      try {
        const draftResp = await groq.chat.completions.create({
          model: GROQ_MODEL,
          messages: [
            {
              role: "system",
              content:
                "You are Stage 1 of Kova Deep Think. Analyze the request quickly, identify core structure, key edge cases, and clear steps.",
            },
            ...safeHistory,
            { role: "user", content: fullUserPrompt },
          ],
          temperature: 0.2,
          max_tokens: 1000,
        });
        groqDraft = draftResp.choices?.[0]?.message?.content || "";
      } catch (_err) {
        groqDraft = "";
      }
    }

    if (!gemini) {
      if (groqDraft) {
        return res.json({ reply: groqDraft, engine: "Kova Fast (Groq)" });
      }
      return res.status(400).json({ error: "Set GEMINI_API_KEY or GROQ_API_KEY in .env" });
    }

    const parts = [];
    const synthesisPrompt = groqDraft
      ? `${KOVA_SYSTEM_PROMPT}\n\n${fullUserPrompt}\n\n--- STAGE-1 FAST ANALYSIS ---\n${groqDraft}\n\nVerify, refine, and synthesize this into a thorough, accurate, well-structured final answer.`
      : `${KOVA_SYSTEM_PROMPT}\n\n${fullUserPrompt}`;

    parts.push({ text: synthesisPrompt });

    if (screenImageBase64) {
      const cleanBase64 = String(screenImageBase64).replace(/^data:image\/\w+;base64,/, "");
      parts.push({
        inlineData: {
          mimeType: "image/png",
          data: cleanBase64,
        },
      });
    }

    try {
      const { text, modelUsed } = await generateWithGeminiFallback(parts, "HIGH");
      return res.json({
        reply: text,
        engine: groqDraft ? `Kova Deep Think (Groq + ${modelUsed})` : `Kova Vision (${modelUsed})`,
      });
    } catch (geminiErr) {
      if (groqDraft) {
        return res.json({
          reply: groqDraft,
          engine: "Kova Deep Fallback (Groq)",
        });
      }
      throw geminiErr;
    }
  } catch (err) {
    console.error("Chat Error:", err);
    res.status(500).json({ error: err.message || "Chat request failed" });
  }
});

app.post("/api/enhance", async (req, res) => {
  try {
    const { prompt = "", goal = "general" } = req.body;
    if (!String(prompt).trim()) {
      return res.status(400).json({ error: "Enter a prompt first." });
    }

    const instruction =
      goal === "image"
        ? "Rewrite this into a clear, vivid, high-detail image generation prompt specifying subject, lighting, style, and composition. Return ONLY the improved prompt."
        : "Rewrite this prompt to be clear, structured, specific, and easy for an AI to answer thoroughly and accurately. Return ONLY the improved prompt.";

    if (groq) {
      const out = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: String(prompt) },
        ],
        temperature: 0.4,
        max_tokens: 400,
      });
      return res.json({ enhanced: out.choices?.[0]?.message?.content?.trim() || prompt });
    }

    if (gemini) {
      const { text } = await generateWithGeminiFallback(
        [{ text: `${instruction}\n\nPrompt: ${prompt}` }],
        "LOW"
      );
      return res.json({ enhanced: text.trim() || prompt });
    }

    res.json({ enhanced: prompt });
  } catch (err) {
    res.status(500).json({ error: err.message || "Enhance failed" });
  }
});

app.post("/api/image", async (req, res) => {
  try {
    const cleanPrompt = String(req.body?.prompt || "").trim();
    if (!cleanPrompt) {
      return res.status(400).json({ error: "Enter an image prompt first." });
    }

    // 1. Cloudflare Workers AI (FLUX.1 Schnell — fast & free daily Neurons)
    if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
      try {
        const cfResp = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ prompt: cleanPrompt, steps: 4 }),
          }
        );
        if (cfResp.ok) {
          const cfJson = await cfResp.json();
          if (cfJson?.result?.image) {
            return res.json({ imageUrl: `data:image/jpeg;base64,${cfJson.result.image}` });
          }
        }
      } catch (_e) {}
    }

    // 2. Gemini Image Models (if billing/quota is active)
    if (gemini) {
      for (const imgModel of GEMINI_IMAGE_MODELS) {
        try {
          const response = await gemini.models.generateContent({
            model: imgModel,
            contents: cleanPrompt,
            config: { responseModalities: ["TEXT", "IMAGE"] },
          });
          const parts = response.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part.inlineData?.data) {
              const mime = part.inlineData.mimeType || "image/png";
              return res.json({ imageUrl: `data:${mime};base64,${part.inlineData.data}` });
            }
          }
        } catch (_e) {}
      }
    }

    // 3. Pollinations Fallback (optional POLLINATIONS_API_KEY or zero-key URL)
    try {
      const seed = Math.floor(Math.random() * 1000000);
      const polUrl = process.env.POLLINATIONS_API_KEY
        ? `https://gen.pollinations.ai/image/${encodeURIComponent(cleanPrompt)}?model=flux&width=768&height=768&seed=${seed}`
        : `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=768&height=768&seed=${seed}`;
      const headers = { "User-Agent": "Mozilla/5.0 KovaAI/1.0" };
      if (process.env.POLLINATIONS_API_KEY) {
        headers.Authorization = `Bearer ${process.env.POLLINATIONS_API_KEY}`;
      }
      const polResp = await fetch(polUrl, { headers });
      if (polResp.ok) {
        const buf = Buffer.from(await polResp.arrayBuffer());
        const mime = polResp.headers.get("content-type") || "image/jpeg";
        if (mime.startsWith("image/")) {
          return res.json({ imageUrl: `data:${mime};base64,${buf.toString("base64")}` });
        }
      }
    } catch (_e) {}

    // 4. Zero-Key Fallback: AI Horde
    const hordeDataUrl = await generateWithAiHorde(cleanPrompt);
    return res.json({ imageUrl: hordeDataUrl });
  } catch (err) {
    console.error("Image Error:", err);
    res.status(500).json({ error: err.message || "Image generation failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Kova running at http://localhost:${PORT}`);
});
