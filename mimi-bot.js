import TelegramBot from "node-telegram-bot-api";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import http from "http";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const MIMI_TELEGRAM_TOKEN = process.env.MIMI_TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const PORT = process.env.PORT || 3001;
const MIMI_URL = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace("https://", "http://");

if (!MIMI_TELEGRAM_TOKEN) throw new Error("MIMI_TELEGRAM_TOKEN is required");

const bot = new TelegramBot(MIMI_TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Mimi is online.");
}).listen(PORT, () => {
  console.log("Port " + PORT);
  setInterval(() => {
    http.get(MIMI_URL, (res) => {
      console.log("Keep-alive ping. Status:", res.statusCode);
    }).on("error", (err) => console.error("Keep-alive error:", err.message));
  }, 10 * 60 * 1000);
});

// ─── Per-user concurrency lock ───────────────────────────────────────────────
const processing = new Map();
async function withUserLock(chatId, fn) {
  const prev = processing.get(chatId) || Promise.resolve();
  let resolve;
  const next = new Promise(r => resolve = r);
  processing.set(chatId, next);
  try { await prev; return await fn(); }
  finally { resolve(); if (processing.get(chatId) === next) processing.delete(chatId); }
}

// ─── Persistent sub-agent threads (memory per user) ─────────────────────────
const joeyThreads = new Map();   // chatId -> threadId
const laraThreads = new Map();   // chatId -> threadId
let joeyAssistantId = null;
let laraAssistantId = null;

async function getOrCreateJoeyAssistant() {
  if (joeyAssistantId) return joeyAssistantId;
  const assistant = await openai.beta.assistants.create({
    name: "Joey",
    instructions: "You are Joey, CL5 Creative team member at Company C, a premium cosmetics brand. You specialize in creative content, ads, copywriting, and social media. You are energetic, imaginative, and detail-oriented. Always produce high-quality, on-brand creative work. Remember context from previous messages in this conversation.",
    model: "gpt-5.4-mini",
  });
  joeyAssistantId = assistant.id;
  console.log("Joey assistant created:", joeyAssistantId);
  return joeyAssistantId;
}

async function getOrCreateLaraAssistant() {
  if (laraAssistantId) return laraAssistantId;
  const assistant = await openai.beta.assistants.create({
    name: "Lara",
    instructions: "You are Lara, Creative Director at Company C, a premium cosmetics brand. You specialize in image direction and visual creative strategy. When asked to generate an image, write a detailed, vivid image generation prompt optimized for premium cosmetics. Return only the image prompt, nothing else.",
    model: "gpt-5.4-mini",
  });
  laraAssistantId = assistant.id;
  console.log("Lara assistant created:", laraAssistantId);
  return laraAssistantId;
}

async function getOrCreateThread(threadMap, chatId) {
  if (threadMap.has(chatId)) return threadMap.get(chatId);
  const thread = await openai.beta.threads.create();
  threadMap.set(chatId, thread.id);
  return thread.id;
}

async function runAssistant(assistantId, threadId, message) {
  // Add message to thread
  await openai.beta.threads.messages.create(threadId, {
    role: "user",
    content: message
  });

  // Run the assistant
  const run = await openai.beta.threads.runs.create(threadId, {
    assistant_id: assistantId,
  });

  // Poll until complete
  let runStatus = run;
  while (runStatus.status !== "completed" && runStatus.status !== "failed") {
    await new Promise(r => setTimeout(r, 1000));
    runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
  }

  if (runStatus.status === "failed") throw new Error("Assistant run failed: " + runStatus.last_error?.message);

  // Get latest message
  const messages = await openai.beta.threads.messages.list(threadId);
  const latest = messages.data[0];
  return latest.content[0].type === "text" ? latest.content[0].text.value : "No response.";
}

// ─── Live status bar helper ──────────────────────────────────────────────────
async function sendStatus(chatId, lines) {
  return await bot.sendMessage(chatId, lines.join("\n"));
}

async function updateStatus(chatId, msgId, lines) {
  try {
    await bot.editMessageText(lines.join("\n"), { chat_id: chatId, message_id: msgId });
  } catch (e) {}
}

// ─── Mimi (Claude) ───────────────────────────────────────────────────────────
const conversations = {};
const MIMI_PROMPT = "You are Mimi, General Manager of Company C, a cosmetics subsidiary. CL4. Team: Lara (Creative Director/images), Zoe (Graphic Designer), Kai (Social Media Lead), Joey (CL5 Creative/copywriter). You delegate creative text to Joey and image generation to Lara. Personality: enthusiastic, creative, warm but professional. Keep responses 3-5 sentences unless creating content.";

async function agentMimi(chatId, text, extraContext) {
  if (!conversations[chatId]) conversations[chatId] = [];
  const userContent = extraContext ? `${text}\n\n[Additional context:\n${extraContext}]` : text;
  conversations[chatId].push({ role: "user", content: userContent });
  if (conversations[chatId].length > 20) conversations[chatId] = conversations[chatId].slice(-20);
  const r = await anthropic.messages.create({
    model: "claude-sonnet-4-5", max_tokens: 1000,
    system: MIMI_PROMPT, messages: conversations[chatId],
  });
  const reply = r.content.find(b => b.type === "text")?.text || "Something went wrong.";
  conversations[chatId].push({ role: "assistant", content: reply });
  return reply;
}

// ─── Joey sub-agent (OpenAI Assistants API with memory) ──────────────────────
async function agentJoey(chatId, task) {
  const assistantId = await getOrCreateJoeyAssistant();
  const threadId = await getOrCreateThread(joeyThreads, chatId);
  return await runAssistant(assistantId, threadId, task);
}

// ─── Lara sub-agent (OpenAI Assistants API + image generation) ───────────────
async function agentLara(chatId, prompt) {
  const assistantId = await getOrCreateLaraAssistant();
  const threadId = await getOrCreateThread(laraThreads, chatId);

  // Lara generates the image prompt using her assistant memory
  const imagePrompt = await runAssistant(assistantId, threadId,
    `Create a detailed image generation prompt for: ${prompt}. Optimized for premium cosmetics. Return only the prompt.`
  );

  // Try Gemini first (free)
  if (GEMINI_API_KEY) {
    try {
      const geminiResponse = await fetch(
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
      const geminiData = await geminiResponse.json();
      const imagePart = geminiData?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (imagePart) {
        return { type: "buffer", data: Buffer.from(imagePart.inlineData.data, "base64"), source: "Gemini" };
      }
    } catch (err) {
      console.error("Gemini error, falling back to gpt-image-1:", err.message);
    }
  }

  // Fallback to gpt-image-1
  const response = await openai.images.generate({
    model: "gpt-image-1",
    prompt: imagePrompt,
    n: 1,
    size: "1024x1024",
  });
  const imageBuffer = Buffer.from(response.data[0].b64_json, "base64");
  return { type: "buffer", data: imageBuffer, source: "gpt-image-1" };
}

// ─── Image reading ────────────────────────────────────────────────────────────
async function readImageText(fileId) {
  try {
    const fileUrl = await bot.getFileLink(fileId);
    const imageResponse = await fetch(fileUrl);
    const buffer = await imageResponse.buffer();
    const base64Image = buffer.toString("base64");
    const response = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_completion_tokens: 500,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
          { type: "text", text: "Read and extract all text, numbers, and letters in this image. If no text, briefly describe it." }
        ]
      }]
    });
    return response.choices[0].message.content;
  } catch (err) { return null; }
}

// ─── URL fetching ─────────────────────────────────────────────────────────────
function extractURL(text) {
  const matches = text.match(/(https?:\/\/[^\s]+)/g);
  return matches ? matches[0] : null;
}

async function fetchWebpage(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MimiBot/1.0)" },
      timeout: 10000
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, noscript").remove();
    const title = $("title").text().trim();
    const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 3000);
    return `Page title: ${title}\n\nContent:\n${text}`;
  } catch (err) { return null; }
}

// ─── Intent detection ─────────────────────────────────────────────────────────
function detectIntent(text) {
  if (/\b(thumbnail|image|photo|picture|graphic|illustration|logo|banner|poster|generate image|create image|draw|design image)\b/i.test(text)) return "lara";
  if (/\b(create|make|write|design|generate|draft|produce)\b/i.test(text) ||
      /\b(ad|advertisement|campaign|copy|caption|post|content|script|brief|slogan|tagline|creative|social media|instagram|facebook|tiktok|flyer)\b/i.test(text)) return "joey";
  return "mimi";
}

// ─── Team mode (parallel with live status) ────────────────────────────────────
async function handleTeam(chatId, task) {
  bot.sendChatAction(chatId, "typing");
  await bot.sendMessage(chatId, "🏢 Mimi is briefing the team...");

  const t1 = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
  const strategy = await agentMimi(chatId, `Create a short creative strategy for: ${task}`);
  clearInterval(t1);
  await bot.sendMessage(chatId, `🧠 Mimi:\n\n${strategy}`);

  // Live status message
  const statusMsg = await sendStatus(chatId, [
    "⚡ Team Status:",
    "🎨 Joey — ⏳ writing...",
    "🖼️ Lara — ⏳ generating..."
  ]);
  const statusId = statusMsg.message_id;
  const status = { joey: "⏳ writing...", lara: "⏳ generating..." };

  const refreshStatus = () => updateStatus(chatId, statusId, [
    "⚡ Team Status:",
    `🎨 Joey — ${status.joey}`,
    `🖼️ Lara — ${status.lara}`
  ]);

  const t2 = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);

  try {
    const [copy, image] = await Promise.all([
      agentJoey(chatId, `Strategy: "${strategy}"\n\nWrite ad copy for: ${task}. Include headline, body copy, caption, hashtags.`)
        .then(r => { status.joey = "✅ done!"; refreshStatus(); return r; })
        .catch(e => { status.joey = "❌ error"; refreshStatus(); throw e; }),
      agentLara(chatId, task)
        .then(r => { status.lara = "✅ done!"; refreshStatus(); return r; })
        .catch(e => { status.lara = "❌ error"; refreshStatus(); throw e; })
    ]);

    clearInterval(t2);
    await bot.sendMessage(chatId, `🎨 Joey:\n\n${copy}`);
    await bot.sendPhoto(chatId, image.data, { caption: `🖼️ Lara (${image.source})` });
    await bot.sendMessage(chatId, "✅ Team delivery complete!");
  } catch (err) {
    clearInterval(t2);
    await bot.sendMessage(chatId, "Team error: " + err.message);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, msg => {
  conversations[msg.chat.id] = [];
  joeyThreads.delete(msg.chat.id);
  laraThreads.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    "Hi! I'm Mimi - GM of Company C.\n\n🧠 Mimi — Strategy (Claude)\n🎨 Joey — Creative sub-agent (GPT-5.4-mini + memory)\n🖼️ Lara — Image sub-agent (Gemini/gpt-image-1 + memory)\n\n/team [task] - Full parallel team\n/ad [product] - Ad concept\n/social [brief] - Social media\n/copy [brief] - Ad copy\n/image [desc] - Generate image\n/brief [product] - Creative brief\n/campaign [product] - Full campaign\n/status - Team status\n/clear - Reset\n\nOr just type naturally!"
  );
});

bot.onText(/\/help/, msg => {
  bot.sendMessage(msg.chat.id,
    "Mimi Bot Commands:\n\n🏢 /team [task]\n/ad [product]\n/social [brief]\n/copy [brief]\n/image [desc]\n/brief [product]\n/campaign [product]\n/translate [text]\n/status\n/clear\n/myid\n\nAuto-routes:\n🧠 Questions → Mimi (Claude)\n🎨 Creative → Joey (sub-agent)\n🖼️ Images → Lara (sub-agent)"
  );
});

bot.onText(/\/clear/, msg => {
  conversations[msg.chat.id] = [];
  joeyThreads.delete(msg.chat.id);
  laraThreads.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, "Cleared! Joey and Lara's memory reset too.");
});

bot.onText(/\/myid/, msg => bot.sendMessage(msg.chat.id, "Your chat ID: " + msg.chat.id));

bot.onText(/\/status/, msg => {
  bot.sendMessage(msg.chat.id,
    "Company C Team:\n🧠 Mimi (GM/Claude) — Online\n🎨 Joey (Creative sub-agent/GPT-5.4-mini) — Online\n🖼️ Lara (Image sub-agent/Gemini) — Online\nZoe (Graphic Designer) — Active\nKai (Social Media) — Active"
  );
});

bot.onText(/\/team (.+)/, async (msg, match) => {
  try { await handleTeam(msg.chat.id, match[1]); }
  catch (err) { bot.sendMessage(msg.chat.id, "Team error: " + err.message); }
});

async function joeyCommand(chatId, task, label) {
  const statusMsg = await sendStatus(chatId, ["⚡ Team Status:", `🎨 Joey — ⏳ ${label}...`]);
  const t = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
  try {
    const reply = await agentJoey(chatId, task);
    clearInterval(t);
    await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🎨 Joey — ✅ done!"]);
    bot.sendMessage(chatId, `🎨 Joey:\n\n${reply}`);
  } catch (err) {
    clearInterval(t);
    await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🎨 Joey — ❌ error"]);
    bot.sendMessage(chatId, "Joey error: " + err.message);
  }
}

async function laraCommand(chatId, prompt) {
  const statusMsg = await sendStatus(chatId, ["⚡ Team Status:", "🖼️ Lara — ⏳ generating..."]);
  const t = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
  try {
    const image = await agentLara(chatId, prompt);
    clearInterval(t);
    await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🖼️ Lara — ✅ done!"]);
    await bot.sendPhoto(chatId, image.data, { caption: `🖼️ Lara (${image.source})` });
  } catch (err) {
    clearInterval(t);
    await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🖼️ Lara — ❌ error"]);
    bot.sendMessage(chatId, "Lara error: " + err.message);
  }
}

bot.onText(/\/image (.+)/, (msg, match) => laraCommand(msg.chat.id, match[1]));
bot.onText(/\/ad (.+)/, (msg, match) => joeyCommand(msg.chat.id, `Create a detailed visual ad concept for: ${match[1]}. Include: headline, subheadline, visual description, color palette, mood, CTA, platform recommendations.`, "working on ad"));
bot.onText(/\/social (.+)/, (msg, match) => joeyCommand(msg.chat.id, `Create social media content for: ${match[1]}. Instagram (caption + hashtags), TikTok (script/concept), Facebook (post copy). Premium cosmetics brand.`, "creating social content"));
bot.onText(/\/copy (.+)/, (msg, match) => joeyCommand(msg.chat.id, `Write ad copy for: ${match[1]}. Long-form, short punchy version, tagline options, key selling points.`, "writing copy"));
bot.onText(/\/brief (.+)/, (msg, match) => joeyCommand(msg.chat.id, `Create a creative brief for: ${match[1]}. Objective, target audience, key message, visual direction, deliverables, timeline.`, "drafting brief"));
bot.onText(/\/campaign (.+)/, (msg, match) => joeyCommand(msg.chat.id, `Create a full ad campaign for: ${match[1]}. Campaign name, theme, target audience, key visuals, channel strategy, content calendar, KPIs.`, "building campaign"));
bot.onText(/\/translate (.+)/, (msg, match) => joeyCommand(msg.chat.id, `Translate this text, provide only the translation: ${match[1]}`, "translating"));

bot.on("photo", async msg => {
  const chatId = msg.chat.id;
  const statusMsg = await sendStatus(chatId, ["⚡ Team Status:", "🎨 Joey — ⏳ reading image..."]);
  const t = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const imageText = await readImageText(photo.file_id);
    clearInterval(t);
    if (!imageText) {
      await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🎨 Joey — ❌ couldn't read image"]);
      return;
    }
    await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🎨 Joey — ✅ done!", "🧠 Mimi — ⏳ responding..."]);
    const caption = msg.caption || "What do you see in this image?";
    const reply = await agentMimi(chatId, caption, `Image content: ${imageText}`);
    await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🎨 Joey — ✅ done!", "🧠 Mimi — ✅ done!"]);
    bot.sendMessage(chatId, reply);
  } catch (err) {
    clearInterval(t);
    bot.sendMessage(chatId, "Error reading image.");
  }
});

bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;

  withUserLock(chatId, async () => {
    try {
      const url = extractURL(msg.text);
      if (url) {
        const statusMsg = await sendStatus(chatId, ["⚡ Team Status:", "🧠 Mimi — ⏳ fetching page..."]);
        const t = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
        const pageContent = await fetchWebpage(url);
        clearInterval(t);
        if (!pageContent) {
          await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🧠 Mimi — ❌ couldn't access page"]);
          return;
        }
        const reply = await agentMimi(chatId, msg.text, pageContent);
        await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🧠 Mimi — ✅ done!"]);
        bot.sendMessage(chatId, reply);
        return;
      }

      const intent = detectIntent(msg.text);

      if (intent === "lara") {
        await laraCommand(chatId, msg.text);
      } else if (intent === "joey") {
        await joeyCommand(chatId, msg.text, "working...");
      } else {
        const statusMsg = await sendStatus(chatId, ["⚡ Team Status:", "🧠 Mimi — ⏳ thinking..."]);
        const t = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
        const reply = await agentMimi(chatId, msg.text);
        clearInterval(t);
        await updateStatus(chatId, statusMsg.message_id, ["⚡ Team Status:", "🧠 Mimi — ✅ done!"]);
        bot.sendMessage(chatId, `🧠 Mimi:\n\n${reply}`);
      }
    } catch (err) {
      bot.sendMessage(chatId, "Something went wrong. Please try again.");
    }
  });
});

console.log("Mimi online - Claude (Mimi) + GPT-5.4-mini sub-agent (Joey) + Gemini/gpt-image-1 sub-agent (Lara) + Parallel Team Mode.");
