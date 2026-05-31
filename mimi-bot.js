import TelegramBot from "node-telegram-bot-api";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import http from "http";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

// ─── Config ──────────────────────────────────────────────────────────────────
const MIMI_TELEGRAM_TOKEN = process.env.MIMI_TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const PORT = process.env.PORT || 3001;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL;

if (!MIMI_TELEGRAM_TOKEN) throw new Error("MIMI_TELEGRAM_TOKEN is required");

// ─── Clients ─────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─── Bot setup (webhook mode — no 409 conflicts) ─────────────────────────────
const bot = new TelegramBot(MIMI_TELEGRAM_TOKEN);

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === `/bot${MIMI_TELEGRAM_TOKEN}`) {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try { bot.processUpdate(JSON.parse(body)); } catch (e) {}
      res.writeHead(200); res.end("OK");
    });
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Mimi is online.");
  }
});

server.listen(PORT, async () => {
  console.log("Port " + PORT);
  if (WEBHOOK_URL) {
    try {
      await bot.deleteWebHook();
      await bot.setWebHook(`${WEBHOOK_URL}/bot${MIMI_TELEGRAM_TOKEN}`);
      console.log("Webhook set:", `${WEBHOOK_URL}/bot${MIMI_TELEGRAM_TOKEN}`);
    } catch (e) {
      console.error("Webhook error:", e.message);
    }
  }
});

// ─── Per-user concurrency lock ────────────────────────────────────────────────
const processing = new Map();
async function withUserLock(chatId, fn) {
  const prev = processing.get(chatId) || Promise.resolve();
  let resolve;
  const next = new Promise(r => resolve = r);
  processing.set(chatId, next);
  try { await prev; return await fn(); }
  finally { resolve(); if (processing.get(chatId) === next) processing.delete(chatId); }
}

// ─── Sub-agent memory (Responses API) ────────────────────────────────────────
const joeyMemory = new Map();
const laraMemory = new Map();

const JOEY_SYSTEM = "You are Joey, CL5 Creative team member at Company C, a premium cosmetics brand. You specialize in creative content, ads, copywriting, and social media. Energetic, imaginative, detail-oriented. Produce high-quality on-brand work. Remember context from previous messages.";
const LARA_SYSTEM = "You are Lara, Creative Director at Company C, a premium cosmetics brand. You specialize in image direction and visual creative strategy. When asked to generate an image, write a detailed vivid image generation prompt optimized for premium cosmetics. Return only the image prompt, nothing else.";

async function runWithMemory(memoryMap, chatId, systemPrompt, userMessage) {
  const previousId = memoryMap.get(chatId);
  const params = {
    model: "gpt-5.4-mini",
    instructions: systemPrompt,
    input: userMessage,
    ...(previousId && { previous_response_id: previousId })
  };
  const response = await openai.responses.create(params);
  memoryMap.set(chatId, response.id);
  return response.output_text;
}

// ─── Live status bar ──────────────────────────────────────────────────────────
async function sendStatus(chatId, lines) {
  return await bot.sendMessage(chatId, lines.join("\n"));
}
async function updateStatus(chatId, msgId, lines) {
  try { await bot.editMessageText(lines.join("\n"), { chat_id: chatId, message_id: msgId }); } catch (e) {}
}

// ─── Mimi agent (Claude) ──────────────────────────────────────────────────────
const mimiConversations = new Map();
const MIMI_PROMPT = "You are Mimi, General Manager of Company C, a cosmetics subsidiary. CL4. Hierarchy: CL1 (top) > CL2 Victor > CL3 Joe > CL4 Mimi > CL5 Joey/Lara/Zoe/Kai. Team: Lara (Creative Director/images), Zoe (Graphic Designer), Kai (Social Media), Joey (Creative/copywriter). Personality: enthusiastic, creative, warm but professional. Keep responses 3-5 sentences unless creating content.";

async function agentMimi(chatId, text, extraContext) {
  if (!mimiConversations.has(chatId)) mimiConversations.set(chatId, []);
  const history = mimiConversations.get(chatId);
  const userContent = extraContext ? `${text}\n\n[Context:\n${extraContext}]` : text;
  history.push({ role: "user", content: userContent });
  if (history.length > 20) history.splice(0, history.length - 20);
  const r = await anthropic.messages.create({
    model: "claude-sonnet-4-5", max_tokens: 1000,
    system: MIMI_PROMPT, messages: history,
  });
  const reply = r.content.find(b => b.type === "text")?.text || "Something went wrong.";
  history.push({ role: "assistant", content: reply });
  return reply;
}

// ─── Joey agent (GPT-5.4-mini with memory) ────────────────────────────────────
async function agentJoey(chatId, task) {
  return await runWithMemory(joeyMemory, chatId, JOEY_SYSTEM, task);
}

// ─── Lara agent (Gemini/gpt-image-1 with memory) ─────────────────────────────
async function agentLara(chatId, prompt) {
  const imagePrompt = await runWithMemory(laraMemory, chatId, LARA_SYSTEM,
    `Create a detailed image generation prompt for: ${prompt}. Optimized for premium cosmetics. Return only the prompt.`
  );

  // Try Gemini first (free)
  if (GEMINI_API_KEY) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: imagePrompt }] }],
            generationConfig: { responseModalities: ["IMAGE", "TEXT"] }
          })
        }
      );
      const data = await res.json();
      const imgPart = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (imgPart) return { data: Buffer.from(imgPart.inlineData.data, "base64"), source: "Gemini" };
    } catch (e) { console.error("Gemini error:", e.message); }
  }

  // Fallback to gpt-image-1
  const r = await openai.images.generate({
    model: "gpt-image-1", prompt: imagePrompt, n: 1, size: "1024x1024"
  });
  return { data: Buffer.from(r.data[0].b64_json, "base64"), source: "gpt-image-1" };
}

// ─── Image reading ────────────────────────────────────────────────────────────
async function readImageText(fileId) {
  try {
    const fileUrl = await bot.getFileLink(fileId);
    const imgRes = await fetch(fileUrl);
    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const r = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_completion_tokens: 500,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: "text", text: "Read and extract all text, numbers, and letters in this image. If no text, briefly describe it." }
        ]
      }]
    });
    return r.choices[0].message.content;
  } catch (e) { return null; }
}

// ─── URL fetching ─────────────────────────────────────────────────────────────
function extractURL(text) {
  const m = text.match(/(https?:\/\/[^\s]+)/g);
  return m ? m[0] : null;
}
async function fetchWebpage(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; MimiBot/1.0)" }, timeout: 10000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, noscript").remove();
    const title = $("title").text().trim();
    const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 3000);
    return `Page title: ${title}\n\nContent:\n${text}`;
  } catch (e) { return null; }
}

// ─── Intent detection ─────────────────────────────────────────────────────────
function detectIntent(text) {
  if (/\b(thumbnail|image|photo|picture|graphic|illustration|logo|banner|poster|generate image|create image|draw|design image|visual)\b/i.test(text)) return "lara";
  if (/\b(create|make|write|design|generate|draft|produce|ad|advertisement|campaign|copy|caption|post|content|script|brief|slogan|tagline|creative|social media|instagram|facebook|tiktok|flyer)\b/i.test(text)) return "joey";
  return "mimi";
}

// ─── Helper: run Joey with status ────────────────────────────────────────────
async function runJoey(chatId, task, label) {
  const sm = await sendStatus(chatId, ["⚡ Team Status:", `🎨 Joey — ⏳ ${label}...`]);
  const t = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
  try {
    const reply = await agentJoey(chatId, task);
    clearInterval(t);
    await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🎨 Joey — ✅ done!"]);
    bot.sendMessage(chatId, `🎨 Joey:\n\n${reply}`);
  } catch (e) {
    clearInterval(t);
    await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🎨 Joey — ❌ error"]);
    bot.sendMessage(chatId, "Joey error: " + e.message);
  }
}

// ─── Helper: run Lara with status ────────────────────────────────────────────
async function runLara(chatId, prompt) {
  const sm = await sendStatus(chatId, ["⚡ Team Status:", "🖼️ Lara — ⏳ generating..."]);
  const t = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
  try {
    const image = await agentLara(chatId, prompt);
    clearInterval(t);
    await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🖼️ Lara — ✅ done!"]);
    await bot.sendPhoto(chatId, image.data, { caption: `🖼️ Lara (${image.source})` });
  } catch (e) {
    clearInterval(t);
    await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🖼️ Lara — ❌ error"]);
    bot.sendMessage(chatId, "Lara error: " + e.message);
  }
}

// ─── Team mode ────────────────────────────────────────────────────────────────
async function runTeam(chatId, task) {
  bot.sendChatAction(chatId, "typing");
  await bot.sendMessage(chatId, "🏢 Mimi is briefing the team...");

  const t1 = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
  const strategy = await agentMimi(chatId, `Create a short creative strategy for: ${task}`);
  clearInterval(t1);
  await bot.sendMessage(chatId, `🧠 Mimi:\n\n${strategy}`);

  const sm = await sendStatus(chatId, ["⚡ Team Status:", "🎨 Joey — ⏳ writing...", "🖼️ Lara — ⏳ generating..."]);
  const status = { joey: "⏳ writing...", lara: "⏳ generating..." };
  const refresh = () => updateStatus(chatId, sm.message_id, ["⚡ Team Status:", `🎨 Joey — ${status.joey}`, `🖼️ Lara — ${status.lara}`]);
  const t2 = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);

  try {
    const [copy, image] = await Promise.all([
      agentJoey(chatId, `Strategy: "${strategy}"\n\nWrite ad copy for: ${task}. Headline, body, caption, hashtags.`)
        .then(r => { status.joey = "✅ done!"; refresh(); return r; })
        .catch(e => { status.joey = "❌ error"; refresh(); throw e; }),
      agentLara(chatId, task)
        .then(r => { status.lara = "✅ done!"; refresh(); return r; })
        .catch(e => { status.lara = "❌ error"; refresh(); throw e; })
    ]);
    clearInterval(t2);
    await bot.sendMessage(chatId, `🎨 Joey:\n\n${copy}`);
    await bot.sendPhoto(chatId, image.data, { caption: `🖼️ Lara (${image.source})` });
    await bot.sendMessage(chatId, "✅ Team delivery complete!");
  } catch (e) {
    clearInterval(t2);
    bot.sendMessage(chatId, "Team error: " + e.message);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;
  mimiConversations.delete(chatId); joeyMemory.delete(chatId); laraMemory.delete(chatId);
  bot.sendMessage(chatId,
    "Hi! I'm Mimi — GM of Company C 💄\n\n🧠 Mimi — Strategy (Claude)\n🎨 Joey — Creative sub-agent (GPT-5.4-mini)\n🖼️ Lara — Image sub-agent (Gemini/gpt-image-1)\n\n/team [task] — Full parallel team\n/image [desc] — Generate image\n/ad [product] — Ad concept\n/social [brief] — Social media\n/copy [brief] — Ad copy\n/brief [product] — Creative brief\n/campaign [product] — Full campaign\n/translate [text] — Translate\n/status — Team status\n/clear — Reset memory\n\nOr just type naturally!"
  );
});

bot.onText(/\/help/, msg => {
  bot.sendMessage(msg.chat.id,
    "Mimi Bot Commands:\n\n🏢 /team [task]\n🖼️ /image [desc]\n/ad [product]\n/social [brief]\n/copy [brief]\n/brief [product]\n/campaign [product]\n/translate [text]\n/status\n/clear\n/myid\n\nAuto-routes:\n🧠 Questions → Mimi\n🎨 Creative/copy → Joey\n🖼️ Images → Lara\n\nSend a URL or image too!"
  );
});

bot.onText(/\/clear/, msg => {
  const chatId = msg.chat.id;
  mimiConversations.delete(chatId); joeyMemory.delete(chatId); laraMemory.delete(chatId);
  bot.sendMessage(chatId, "✅ Cleared! All memory reset.");
});

bot.onText(/\/myid/, msg => bot.sendMessage(msg.chat.id, "Your chat ID: " + msg.chat.id));

bot.onText(/\/status/, msg => {
  bot.sendMessage(msg.chat.id,
    "Company C Team:\n🧠 Mimi (GM/Claude) — Online\n🎨 Joey (Creative/GPT-5.4-mini) — Online\n🖼️ Lara (Images/Gemini) — Online\nZoe (Graphic Designer) — Active\nKai (Social Media) — Active"
  );
});

bot.onText(/\/team (.+)/, async (msg, match) => {
  try { await runTeam(msg.chat.id, match[1]); }
  catch (e) { bot.sendMessage(msg.chat.id, "Team error: " + e.message); }
});

bot.onText(/\/image (.+)/, (msg, match) => runLara(msg.chat.id, match[1]));
bot.onText(/\/ad (.+)/, (msg, match) => runJoey(msg.chat.id, `Create a detailed visual ad concept for: ${match[1]}. Include headline, subheadline, visual description, color palette, mood, CTA, platform recommendations.`, "creating ad"));
bot.onText(/\/social (.+)/, (msg, match) => runJoey(msg.chat.id, `Create social media content for: ${match[1]}. Instagram (caption + hashtags), TikTok (script), Facebook (post). Premium cosmetics brand.`, "creating social content"));
bot.onText(/\/copy (.+)/, (msg, match) => runJoey(msg.chat.id, `Write ad copy for: ${match[1]}. Long-form, short punchy version, tagline options, key selling points.`, "writing copy"));
bot.onText(/\/brief (.+)/, (msg, match) => runJoey(msg.chat.id, `Create a creative brief for: ${match[1]}. Objective, target audience, key message, visual direction, deliverables, timeline.`, "drafting brief"));
bot.onText(/\/campaign (.+)/, (msg, match) => runJoey(msg.chat.id, `Create a full ad campaign for: ${match[1]}. Campaign name, theme, target audience, key visuals, channel strategy, content calendar, KPIs.`, "building campaign"));
bot.onText(/\/translate (.+)/, (msg, match) => runJoey(msg.chat.id, `Translate this text, provide only the translation: ${match[1]}`, "translating"));

// ─── Photo handler ────────────────────────────────────────────────────────────
bot.on("photo", async msg => {
  const chatId = msg.chat.id;
  const sm = await sendStatus(chatId, ["⚡ Team Status:", "🎨 Joey — ⏳ reading image...", "🧠 Mimi — ⏳ waiting..."]);
  const t = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const imageText = await readImageText(photo.file_id);
    if (!imageText) {
      clearInterval(t);
      await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🎨 Joey — ❌ couldn't read image"]);
      return;
    }
    await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🎨 Joey — ✅ done!", "🧠 Mimi — ⏳ responding..."]);
    const caption = msg.caption || "What do you see in this image?";
    const reply = await agentMimi(chatId, caption, `Image content: ${imageText}`);
    clearInterval(t);
    await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🎨 Joey — ✅ done!", "🧠 Mimi — ✅ done!"]);
    bot.sendMessage(chatId, reply);
  } catch (e) {
    clearInterval(t);
    bot.sendMessage(chatId, "Error reading image.");
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────
bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;

  withUserLock(chatId, async () => {
    try {
      const url = extractURL(msg.text);
      if (url) {
        const sm = await sendStatus(chatId, ["⚡ Team Status:", "🧠 Mimi — ⏳ fetching page..."]);
        const t = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
        const pageContent = await fetchWebpage(url);
        clearInterval(t);
        if (!pageContent) {
          await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🧠 Mimi — ❌ couldn't access page"]);
          return;
        }
        const reply = await agentMimi(chatId, msg.text, pageContent);
        await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🧠 Mimi — ✅ done!"]);
        bot.sendMessage(chatId, reply);
        return;
      }

      const intent = detectIntent(msg.text);
      if (intent === "lara") {
        await runLara(chatId, msg.text);
      } else if (intent === "joey") {
        await runJoey(chatId, msg.text, "working");
      } else {
        const sm = await sendStatus(chatId, ["⚡ Team Status:", "🧠 Mimi — ⏳ thinking..."]);
        const t = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
        const reply = await agentMimi(chatId, msg.text);
        clearInterval(t);
        await updateStatus(chatId, sm.message_id, ["⚡ Team Status:", "🧠 Mimi — ✅ done!"]);
        bot.sendMessage(chatId, `🧠 Mimi:\n\n${reply}`);
      }
    } catch (e) {
      bot.sendMessage(chatId, "Something went wrong. Please try again.");
    }
  });
});

console.log("Mimi online — Claude + GPT-5.4-mini (Joey) + Gemini/gpt-image-1 (Lara) | Webhook mode");
