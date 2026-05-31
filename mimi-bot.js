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

const MIMI_PROMPT = "You are Mimi, General Manager of Company C, a cosmetics subsidiary. CL4. Team: Lara (Creative Director/image generation), Zoe (Graphic Designer), Kai (Social Media Lead), Joey (CL5 Creative/copywriter). You delegate creative text to Joey and image generation to Lara. Personality: enthusiastic, creative, warm but professional. Keep responses 3-5 sentences unless creating content.";

const JOEY_PROMPT = "You are Joey, CL5 Creative team member at Company C, a premium cosmetics brand. You work under Mimi (GM) and specialize in creative content, ads, copywriting, and social media. You are energetic, imaginative, and detail-oriented. Always produce high-quality, on-brand creative work.";

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
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
          { type: "text", text: "Please read and extract all text, numbers, and letters visible in this image. If there is no text, describe what you see briefly." }
        ]
      }]
    });
    return response.choices[0].message.content;
  } catch (err) {
    return null;
  }
}

async function handleMimi(chatId, text, extraContext) {
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

// Joey — GPT-4.5 creative text
async function handleJoey(text, extraSystem) {
  const sys = extraSystem || JOEY_PROMPT;
  const r = await openai.chat.completions.create({
    model: "gpt-5.4-mini", max_tokens: 1500,
    messages: [{ role: "system", content: sys }, { role: "user", content: text }],
  });
  return r.choices[0].message.content;
}

// Lara — Google Gemini image generation (free) with DALL-E 3 fallback
async function handleLara(prompt) {
  const refinedPrompt = await handleJoey(
    `Create a detailed image generation prompt for: ${prompt}. Make it vivid, specific, and optimized for a premium cosmetics brand. Return only the image prompt, nothing else.`,
    "You are Joey, a creative prompt engineer for AI image generation at Company C cosmetics."
  );

  // Try Google Gemini first (free)
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
        const imageBuffer = Buffer.from(imagePart.inlineData.data, "base64");
        return { type: "buffer", data: imageBuffer, mimeType: imagePart.inlineData.mimeType };
      }
    } catch (err) {
      console.error("Gemini error, falling back to DALL-E 3:", err.message);
    }
  }

  // Fallback to DALL-E 3
  const response = await openai.images.generate({
    model: "dall-e-3",
    prompt: refinedPrompt,
    n: 1,
    size: "1024x1024",
    quality: "standard",
  });
  return { type: "url", data: response.data[0].url };
}

// Team mode — Mimi coordinates Joey and Lara together
async function handleTeam(chatId, task) {
  await bot.sendMessage(chatId, "🏢 Mimi is briefing the team...");

  // Step 1: Mimi creates the strategy
  const strategy = await handleMimi(chatId, `Create a short creative strategy and brief for the team for: ${task}`);
  await bot.sendMessage(chatId, `🧠 Mimi (Strategy):\n\n${strategy}`);

  // Step 2: Joey writes the copy
  await bot.sendMessage(chatId, "🎨 Joey is writing the copy...");
  const copy = await handleJoey(
    `Based on this strategy: "${strategy}"\n\nWrite complete ad copy for: ${task}. Include headline, body copy, caption, and hashtags.`
  );
  await bot.sendMessage(chatId, `🎨 Joey (Copy):\n\n${copy}`);

  // Step 3: Lara generates the image
  await bot.sendMessage(chatId, "🖼️ Lara is generating the visual...");
  try {
    const image = await handleLara(task);
    if (image.type === "buffer") {
      await bot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (Visual)" });
    } else {
      await bot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (Visual)" });
    }
  } catch (err) {
    await bot.sendMessage(chatId, "🖼️ Lara couldn't generate the image: " + err.message);
  }

  await bot.sendMessage(chatId, "✅ Team delivery complete!");
}

bot.onText(/\/start/, msg => {
  conversations[msg.chat.id] = [];
  bot.sendMessage(msg.chat.id,
    "Hi! I'm Mimi - GM of Company C.\n\nMy team:\n🧠 Mimi — Strategy (Claude)\n🎨 Joey — Copy & creative (GPT-4.5)\n🖼️ Lara — Images (Gemini/DALL-E 3)\n\n/team [task] - Full team delivery\n/ad [product] - Ad concept\n/social [brief] - Social media\n/copy [brief] - Ad copy\n/image [description] - Generate image\n/brief [product] - Creative brief\n/campaign [product] - Full campaign\n/status - Team status\n/clear - Reset\n\nOr just type naturally!"
  );
});

bot.onText(/\/help/, msg => {
  bot.sendMessage(msg.chat.id,
    "Mimi Bot Commands:\n\n🏢 /team [task] - Full team mode\n/ad [product]\n/social [brief]\n/copy [brief]\n/image [description]\n/brief [product]\n/campaign [product]\n/translate [text]\n/status\n/clear\n/myid\n\nAuto-routes:\n🧠 Questions → Mimi (Claude)\n🎨 Creative → Joey (GPT-4.5)\n🖼️ Images → Lara (Gemini/DALL-E 3)"
  );
});

bot.onText(/\/clear/, msg => { conversations[msg.chat.id] = []; bot.sendMessage(msg.chat.id, "Cleared!"); });
bot.onText(/\/myid/, msg => { bot.sendMessage(msg.chat.id, "Your chat ID: " + msg.chat.id); });

bot.onText(/\/status/, msg => {
  bot.sendMessage(msg.chat.id, "Company C Team:\n🧠 Mimi (GM/Claude) — Online\n🎨 Joey (Creative/GPT-4.5) — Online\n🖼️ Lara (Images/Gemini) — Online\nZoe (Graphic Designer) — Active\nKai (Social Media) — Active");
});

bot.onText(/\/team (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  try {
    await handleTeam(chatId, match[1]);
  } catch (err) { bot.sendMessage(chatId, "Team error: " + err.message); }
});

bot.onText(/\/image (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "🖼️ Lara is generating your image...");
  try {
    const image = await handleLara(match[1]);
    if (image.type === "buffer") {
      await bot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (Gemini)" });
    } else {
      await bot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (DALL-E 3)" });
    }
  } catch (err) { bot.sendMessage(chatId, "Error generating image: " + err.message); }
});

bot.onText(/\/ad (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "🎨 Joey is working on your ad concept...");
  try {
    const reply = await handleJoey("Create a detailed visual advertisement concept for: " + match[1] + ". Include: headline, subheadline, visual description, color palette, mood, call to action, platform recommendations.", "You are Joey, CL5 Creative at Company C. Create stunning ad concepts for a premium cosmetics brand.");
    bot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
  } catch (err) { bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/social (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "🎨 Joey is creating social media content...");
  try {
    const reply = await handleJoey("Create engaging social media content for: " + match[1] + ". Provide versions for Instagram (caption + hashtags), TikTok (script/concept), Facebook (post copy).", "You are Joey, CL5 Social Media Creative at Company C.");
    bot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
  } catch (err) { bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/copy (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "🎨 Joey is writing ad copy...");
  try {
    const reply = await handleJoey("Write compelling ad copy for: " + match[1] + ". Include: long-form copy, short punchy version, tagline options, key selling points.", "You are Joey, CL5 Copywriter at Company C.");
    bot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
  } catch (err) { bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/brief (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "🎨 Joey is drafting the creative brief...");
  try {
    const reply = await handleJoey("Create a detailed creative brief for: " + match[1] + ". Include: objective, target audience, key message, visual direction, deliverables, timeline suggestions.", "You are Joey, CL5 Creative at Company C.");
    bot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
  } catch (err) { bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/campaign (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "🎨 Joey is building the campaign...");
  try {
    const reply = await handleJoey("Create a full advertising campaign for: " + match[1] + ". Include: campaign name, theme, target audience, key visuals, channel strategy, content calendar outline, KPIs.", "You are Joey, CL5 Campaign Creative at Company C.");
    bot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
  } catch (err) { bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/translate (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  try {
    const reply = await handleJoey("Translate this text, provide only the translation: " + match[1]);
    bot.sendMessage(chatId, "Translation:\n\n" + reply);
  } catch (err) { bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.on("photo", async msg => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, "typing");
  bot.sendMessage(chatId, "🎨 Joey is reading the image...");
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const imageText = await readImageText(photo.file_id);
    if (!imageText) {
      bot.sendMessage(chatId, "Sorry, I couldn't read that image. Please try again.");
      return;
    }
    const caption = msg.caption || "What do you see in this image? Read all text and describe it.";
    const reply = await handleMimi(chatId, caption, `Image content: ${imageText}`);
    bot.sendMessage(chatId, reply);
  } catch (err) {
    bot.sendMessage(chatId, "Something went wrong reading the image. Please try again.");
  }
});

bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, "typing");
  try {
    const url = extractURL(msg.text);
    if (url) {
      bot.sendMessage(chatId, "Fetching that page for you...");
      const pageContent = await fetchWebpage(url);
      if (!pageContent) {
        bot.sendMessage(chatId, "Sorry, I couldn't access that page. It may be blocked or require a login.");
        return;
      }
      const reply = await handleMimi(chatId, msg.text, pageContent);
      bot.sendMessage(chatId, reply);
      return;
    }
    const intent = detectIntent(msg.text);
    if (intent === "lara") {
      bot.sendMessage(chatId, "🖼️ Passing to Lara...");
      const image = await handleLara(msg.text);
      if (image.type === "buffer") {
        await bot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (Gemini)" });
      } else {
        await bot.sendPhoto(chatId, image.data, { caption: "🖼️ Lara (DALL-E 3)" });
      }
    } else if (intent === "joey") {
      bot.sendMessage(chatId, "🎨 Passing to Joey...");
      const reply = await handleJoey(msg.text);
      bot.sendMessage(chatId, "🎨 Joey:\n\n" + reply);
    } else {
      const reply = await handleMimi(chatId, msg.text);
      bot.sendMessage(chatId, "🧠 Mimi:\n\n" + reply);
    }
  } catch (err) { bot.sendMessage(chatId, "Something went wrong. Please try again."); }
});

console.log("Mimi online - Claude (Mimi) + GPT-4.5 (Joey) + Gemini/DALL-E 3 (Lara) + Team Mode.");
