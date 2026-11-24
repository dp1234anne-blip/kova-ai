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
  : null;

const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const GROQ_MODEL = "openai/gpt-oss-20b";
const GROQ_SAFE_CHAR_BUDGET = 18000;
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

function estimateTokens(str) {
  return Math.ceil(String(str || "").length / 4);
}

function buildCompactContext({ language, memory, tasks, fileContext, maxFileChars = 2500 }) {
  const safeMem = Array.isArray(memory) ? memory.slice(-10) : [];
  const safeTasks = Array.isArray(tasks) ? tasks.slice(-10) : [];

  return [
    `Active Language: ${language}`,
    safeMem.length ? `Saved User Memory:\n${safeMem.map((m) => `- ${String(m).slice(0, 160)}`).join("\n")}` : "",
    safeTasks.length
      ? `User Tasks:\n${safeTasks.map((t) => `- [${t.done ? "DONE" : "OPEN"}] ${String(t.title).slice(0, 160)}`).join("\n")}`
      : "",
    fileContext && fileContext.content
      ? `Workspace File (${fileContext.name || "untitled"}):\n${String(fileContext.content).slice(0, maxFileChars)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildCompactHistory(history, maxTurns = 4, maxCharsPerMsg = 1200) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-maxTurns * 2)
    .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
    .map((h) => ({
      role: h.role,
      content: h.content.length > maxCharsPerMsg ? `${h.content.slice(0, maxCharsPerMsg)}...` : h.content,
    }));
}

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

    const compactContext = buildCompactContext({
      language,
      memory,
      tasks,
      fileContext,
      maxFileChars: 2500,
    });
    const fullUserPrompt = `${compactContext}\n\nUser Request:\n${String(message).slice(0, 6000)}`;
    const safeHistory = buildCompactHistory(history, 4, 1000);
    const historyChars = safeHistory.reduce((acc, m) => acc + m.content.length, 0);
    const totalGroqChars = KOVA_SYSTEM_PROMPT.length + fullUserPrompt.length + historyChars;
    const fitsGroqBudget = totalGroqChars <= GROQ_SAFE_CHAR_BUDGET;

    if (mode === "fast" && !screenImageBase64 && groq && fitsGroqBudget) {
      try {
        const completion = await groq.chat.completions.create({
          model: GROQ_MODEL,
          messages: [
            { role: "system", content: KOVA_SYSTEM_PROMPT },
            ...safeHistory,
            { role: "user", content: fullUserPrompt },
          ],
          temperature: 0.3,
          max_tokens: 800,
        });

        return res.json({
          reply: completion.choices?.[0]?.message?.content || "Done.",
          engine: "Kova Fast (Groq)",
        });
      } catch (groqErr) {
        if (groqErr?.status !== 413 && groqErr?.status !== 429) {
          throw groqErr;
        }
      }
    }

    let groqDraft = "";
    if (groq && !screenImageBase64 && fitsGroqBudget) {
      try {
        const draftResp = await groq.chat.completions.create({
          model: GROQ_MODEL,
          messages: [
            {
              role: "system",
              content:
                "You are Stage 1 of Kova Deep Think. Give a concise outline of core structure, edge cases, and steps in under 350 words.",
            },
            ...safeHistory,
            { role: "user", content: fullUserPrompt },
          ],
          temperature: 0.2,
          max_tokens: 600,
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
      return res.status(400).json({ error: "Set GEMINI_API_KEY or GROQ_API_KEY in environment variables." });
    }

    const richContext = buildCompactContext({
      language,
      memory,
      tasks,
      fileContext,
      maxFileChars: 12000,
    });
    const richUserPrompt = `${richContext}\n\nUser Request:\n${message}`;

    const parts = [];
    const synthesisPrompt = groqDraft
      ? `${KOVA_SYSTEM_PROMPT}\n\n${richUserPrompt}\n\n--- STAGE-1 FAST OUTLINE ---\n${groqDraft}\n\nVerify, refine, and synthesize this into a thorough, accurate, well-structured final answer.`
      : `${KOVA_SYSTEM_PROMPT}\n\n${richUserPrompt}`;

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
        engine: groqDraft ? `Kova Deep Think (Groq + ${modelUsed})` : `Kova Deep (${modelUsed})`,
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
    const trimmedPrompt = String(prompt).trim().slice(0, 3000);
    if (!trimmedPrompt) {
      return res.status(400).json({ error: "Enter a prompt first." });
    }

    const instruction =
      goal === "image"
        ? "Rewrite this into a clear, vivid, high-detail image generation prompt specifying subject, lighting, style, and composition. Return ONLY the improved prompt."
        : "Rewrite this prompt to be clear, structured, specific, and easy for an AI to answer thoroughly and accurately. Return ONLY the improved prompt.";

    if (groq && estimateTokens(instruction + trimmedPrompt) < 5500) {
      try {
        const out = await groq.chat.completions.create({
          model: GROQ_MODEL,
          messages: [
            { role: "system", content: instruction },
            { role: "user", content: trimmedPrompt },
          ],
          temperature: 0.4,
          max_tokens: 250,
        });
        return res.json({ enhanced: out.choices?.[0]?.message?.content?.trim() || trimmedPrompt });
      } catch (err) {
        if (err?.status !== 413 && err?.status !== 429) throw err;
      }
    }

    if (gemini) {
      const { text } = await generateWithGeminiFallback(
        [{ text: `${instruction}\n\nPrompt: ${trimmedPrompt}` }],
        "LOW"
      );
      return res.json({ enhanced: text.trim() || trimmedPrompt });
    }

    res.json({ enhanced: trimmedPrompt });
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
