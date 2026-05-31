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
      console.log("Keep-alive ping sent. Status:", res.statusCode);
    }).on("error", (err) => {
      console.error("Keep-alive error:", err.message);
    });
  }, 10 * 60 * 1000);
});

const conversations = {};
const processing = new Map(); // track per-user processing

async function withUserLock(chatId, fn) {
  // Each user gets their own async chain — no blocking other users
  const prev = processing.get(chatId) || Promise.resolve();
  let resolve;
  const next = new Promise(r => resolve = r);
  processing.set(chatId, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve();
    if (processing.get(chatId) === next) processing.delete(chatId);
  }
}

// Keep typing indicator running until task is done
async function keepTyping(chatId, durationMs) {
  const interval = 4500;
  const times = Math.ceil(durationMs / interval);
  for (let i = 0; i < times; i++) {
    bot.sendChatAction(chatId, "typing");
    await new Promise(r => setTimeout(r, interval));
  }
}

const MIMI_PROMPT = "You are Mimi, General Manager of Company C, a cosmetics subsidiary. CL4. Team: Lara (Creative Director/image generation), Zoe (Graphic Designer), Kai (Social Media Lead), Joey (CL5 Creative/copywriter). You delegate creative text to Joey and image generation to Lara. Personality: enthusiastic, creative, warm but professional. Keep responses 3-5 sentences unless creating content.";

const JOEY_PROMPT = "You are Joey, CL5 Creative team member at Company C, a premium cosmetics brand. You specialize in creative content, ads, copywriting, and social media. You are energetic, imaginative, and detail-oriented. Always produce high-quality, on-brand creative work. Be concise and fast.";

function detectIntent(text) {
  if (/\b(thumbnail|image|photo|picture|graphic|illustration|logo|banner|poster|generate image|create image|draw|design image)\b/i.test(text)) return "lara";
  if (/\b(create|make|write|design|generate|draft|produce)\b/i.test(text) ||
      /\b(ad|advertisement|campaign|copy|caption|post|content|script|brief|slogan|tagline|creative|social media|instagram|facebook|tiktok|flyer)\b/i.test(text)) return "joey";
  return "mimi";
}

function extractURL(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(urlRegex);
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
  } catch (err) {
    return null;
  }
}

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
  } catch (err) {
    return null;
  }
}

// Mimi sub-agent (Claude)
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

// Joey sub-agent (GPT-5.4-mini) — fast creative text
async function agentJoey(task, context) {
  const prompt = context ? `Context: ${context}\n\nTask: ${task}` : task;
  const r = await openai.chat.completions.create({
    model: "gpt-5.4-mini",
    max_completion_tokens: 1200,
    messages: [
      { role: "system", content: JOEY_PROMPT },
      { role: "user", content: prompt }
    ],
  });
  return r.choices[0].message.content;
}

// Lara sub-agent (Gemini/DALL-E 3) — image generation
async function agentLara(prompt) {
  // Joey quickly refines the prompt in parallel
  const refinedPrompt = await agentJoey(
    `Write a vivid DALL-E/Gemini image prompt for: ${prompt}. Optimized for premium cosmetics. Return only the prompt.`,
    null
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
            contents: [{ parts: [{ text: refinedPrompt }] }],
            generationConfig: { responseModalities: ["IMAGE", "TEXT"] }
          })
        }
      );
      const geminiData = await geminiResponse.json();
      const imagePart = geminiData?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (imagePart) {
        return { type: "buffer", data: Buffer.from(imagePart.inlineData.data, "base64") };
      }
    } catch (err) {
      console.error("Gemini error, falling back to DALL-E 3:", err.message);
    }
  }

  // Fallback to DALL-E 3
  const response = await openai.images.generate({
    model: "gpt-image-1",
    prompt: refinedPrompt,
    n: 1,
    size: "1024x1024",
  });
  const imageBuffer = Buffer.from(response.data[0].b64_json, "base64");
  return { type: "buffer", data: imageBuffer };
}

// Team mode — Mimi briefs, Joey & Lara work in PARALLEL
async function handleTeam(chatId, task) {
  // Mimi starts typing immediately
  bot.sendChatAction(chatId, "typing");
  await bot.sendMessage(chatId, "🏢 Mimi is briefing the team...");

  // Step 1: Mimi creates strategy (fast)
  bot.sendChatAction(chatId, "typing");
  const strategy = await agentMimi(chatId, `Create a short creative strategy for: ${task}`);
  await bot.sendMessage(chatId, `🧠 Mimi:\n\n${strategy}`);

  // Step 2: Joey & Lara work IN PARALLEL — both start immediately
  await bot.sendMessage(chatId, "🎨 Joey is writing... 🖼️ Lara is generating... (working in parallel)");

  // Start typing indicators for both
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);

  try {
    const [copy, image] = await Promise.all([
      agentJoey(`Strategy: "${strategy}"\n\nWrite ad copy for: ${task}. Include headline, body copy, caption, hashtags.`),
      agentLara(task)
    ]);

    clearInterval(typingInterval);

    // Send Joey's copy
    await bot.sendMessage(chatId, `🎨 Joey:\n\n${copy}`);

    // Send Lara's image
    if (image.type === "buffer") {
      await bot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (Gemini)" });
    } else {
      await bot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (DALL-E 3)" });
    }

    await bot.sendMessage(chatId, "✅ Team delivery complete!");
  } catch (err) {
    clearInterval(typingInterval);
    await bot.sendMessage(chatId, "Team error: " + err.message);
  }
}

bot.onText(/\/start/, msg => {
  conversations[msg.chat.id] = [];
  bot.sendMessage(msg.chat.id,
    "Hi! I'm Mimi - GM of Company C.\n\n🧠 Mimi — Strategy (Claude)\n🎨 Joey — Copy & creative (GPT-5.4-mini)\n🖼️ Lara — Images (Gemini/DALL-E 3)\n\n/team [task] - Full parallel team delivery\n/ad [product] - Ad concept\n/social [brief] - Social media\n/copy [brief] - Ad copy\n/image [description] - Generate image\n/brief [product] - Creative brief\n/campaign [product] - Full campaign\n/status - Team status\n/clear - Reset\n\nOr just type naturally!"
  );
});

bot.onText(/\/help/, msg => {
  bot.sendMessage(msg.chat.id,
    "Mimi Bot Commands:\n\n🏢 /team [task] - Full parallel team mode\n/ad [product]\n/social [brief]\n/copy [brief]\n/image [description]\n/brief [product]\n/campaign [product]\n/translate [text]\n/status\n/clear\n/myid\n\nAuto-routes:\n🧠 Questions → Mimi (Claude)\n🎨 Creative → Joey (GPT-5.4-mini)\n🖼️ Images → Lara (Gemini/DALL-E 3)"
  );
});

bot.onText(/\/clear/, msg => { conversations[msg.chat.id] = []; bot.sendMessage(msg.chat.id, "Cleared!"); });
bot.onText(/\/myid/, msg => { bot.sendMessage(msg.chat.id, "Your chat ID: " + msg.chat.id); });

bot.onText(/\/status/, msg => {
  bot.sendMessage(msg.chat.id, "Company C Team:\n🧠 Mimi (GM/Claude) — Online\n🎨 Joey (Creative/GPT-5.4-mini) — Online\n🖼️ Lara (Images/Gemini) — Online\nZoe (Graphic Designer) — Active\nKai (Social Media) — Active");
});

bot.onText(/\/team (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  try { await handleTeam(chatId, match[1]); }
  catch (err) { bot.sendMessage(chatId, "Team error: " + err.message); }
});

bot.onText(/\/image (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, "typing");
  bot.sendMessage(chatId, "🖼️ Lara is generating your image...");
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
  try {
    const image = await agentLara(match[1]);
    clearInterval(typingInterval);
    if (image.type === "buffer") {
      await bot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (Gemini)" });
    } else {
      await bot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (DALL-E 3)" });
    }
  } catch (err) { clearInterval(typingInterval); bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/ad (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, "typing");
  bot.sendMessage(chatId, "🎨 Joey is on it...");
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
  try {
    const reply = await agentJoey("Create a detailed visual ad concept for: " + match[1] + ". Include: headline, subheadline, visual description, color palette, mood, CTA, platform recommendations.");
    clearInterval(typingInterval);
    bot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
  } catch (err) { clearInterval(typingInterval); bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/social (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, "typing");
  bot.sendMessage(chatId, "🎨 Joey is on it...");
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
  try {
    const reply = await agentJoey("Create social media content for: " + match[1] + ". Instagram (caption + hashtags), TikTok (script/concept), Facebook (post copy). Premium cosmetics brand.");
    clearInterval(typingInterval);
    bot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
  } catch (err) { clearInterval(typingInterval); bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/copy (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, "typing");
  bot.sendMessage(chatId, "🎨 Joey is on it...");
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
  try {
    const reply = await agentJoey("Write ad copy for: " + match[1] + ". Long-form, short punchy version, tagline options, key selling points.");
    clearInterval(typingInterval);
    bot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
  } catch (err) { clearInterval(typingInterval); bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/brief (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, "typing");
  bot.sendMessage(chatId, "🎨 Joey is on it...");
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
  try {
    const reply = await agentJoey("Create a creative brief for: " + match[1] + ". Objective, target audience, key message, visual direction, deliverables, timeline.");
    clearInterval(typingInterval);
    bot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
  } catch (err) { clearInterval(typingInterval); bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/campaign (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, "typing");
  bot.sendMessage(chatId, "🎨 Joey is on it...");
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
  try {
    const reply = await agentJoey("Create a full ad campaign for: " + match[1] + ". Campaign name, theme, target audience, key visuals, channel strategy, content calendar, KPIs.");
    clearInterval(typingInterval);
    bot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
  } catch (err) { clearInterval(typingInterval); bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/translate (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, "typing");
  try {
    const reply = await agentJoey("Translate this text, provide only the translation: " + match[1]);
    bot.sendMessage(chatId, "Translation:\n\n" + reply);
  } catch (err) { bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.on("photo", async msg => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, "typing");
  bot.sendMessage(chatId, "🎨 Joey is reading the image...");
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const imageText = await readImageText(photo.file_id);
    clearInterval(typingInterval);
    if (!imageText) { bot.sendMessage(chatId, "Sorry, couldn't read that image."); return; }
    const caption = msg.caption || "What do you see in this image?";
    const reply = await agentMimi(chatId, caption, `Image content: ${imageText}`);
    bot.sendMessage(chatId, reply);
  } catch (err) { clearInterval(typingInterval); bot.sendMessage(chatId, "Error reading image."); }
});

bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, "typing");

  withUserLock(chatId, async () => {
  try {
    const url = extractURL(msg.text);
    if (url) {
      bot.sendMessage(chatId, "Fetching that page...");
      const typingInterval = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
      const pageContent = await fetchWebpage(url);
      clearInterval(typingInterval);
      if (!pageContent) { bot.sendMessage(chatId, "Sorry, couldn't access that page."); return; }
      const reply = await agentMimi(chatId, msg.text, pageContent);
      bot.sendMessage(chatId, reply);
      return;
    }

    const intent = detectIntent(msg.text);
    if (intent === "lara") {
      bot.sendMessage(chatId, "🖼️ Lara is on it...");
      const typingInterval = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
      try {
        const image = await agentLara(msg.text);
        clearInterval(typingInterval);
        if (image.type === "buffer") {
          await bot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (Gemini)" });
        } else {
          await bot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (DALL-E 3)" });
        }
      } catch (err) { clearInterval(typingInterval); bot.sendMessage(chatId, "Lara error: " + err.message); }
    } else if (intent === "joey") {
      bot.sendMessage(chatId, "🎨 Joey is on it...");
      const typingInterval = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
      try {
        const reply = await agentJoey(msg.text);
        clearInterval(typingInterval);
        bot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
      } catch (err) { clearInterval(typingInterval); bot.sendMessage(chatId, "Joey error: " + err.message); }
    } else {
      const typingInterval = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);
      const reply = await agentMimi(chatId, msg.text);
      clearInterval(typingInterval);
      bot.sendMessage(chatId, "🧠 Mimi:\n\n" + reply);
    }
  } catch (err) { bot.sendMessage(chatId, "Something went wrong. Please try again."); }
  }); // end withUserLock
});

console.log("Mimi online - Claude (Mimi) + GPT-5.4-mini (Joey) + Gemini/DALL-E 3 (Lara) + Parallel Team Mode.");
