import TelegramBot from "node-telegram-bot-api";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import http from "http";

const MIMI_TELEGRAM_TOKEN = process.env.MIMI_TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const PORT = process.env.PORT || 3001;

if (!MIMI_TELEGRAM_TOKEN) throw new Error("MIMI_TELEGRAM_TOKEN is required");

const bot = new TelegramBot(MIMI_TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Mimi is online.");
}).listen(PORT, () => console.log("Port " + PORT));

const conversations = {};

const MIMI_PROMPT = "You are Mimi, General Manager of Company C, a cosmetics subsidiary. CL4. Team: Lara (Creative Director), Zoe (Graphic Designer), Kai (Social Media Lead). You have ChatGPT for visual ads and creative work. Personality: enthusiastic, creative, warm but professional. Keep responses 3-5 sentences unless creating content.";

function detectAI(text) {
  if (/\b(create|make|write|design|generate|draft|produce)\b/i.test(text) ||
      /\b(ad|advertisement|campaign|copy|caption|post|content|script|brief|slogan|tagline|banner|visual|creative|social media|instagram|facebook|tiktok|poster|flyer)\b/i.test(text)) {
    return "chatgpt";
  }
  return "mimi";
}

async function handleMimi(chatId, text) {
  if (!conversations[chatId]) conversations[chatId] = [];
  conversations[chatId].push({ role: "user", content: text });
  if (conversations[chatId].length > 20) conversations[chatId] = conversations[chatId].slice(-20);
  const r = await anthropic.messages.create({
    model: "claude-sonnet-4-5", max_tokens: 1000,
    system: MIMI_PROMPT, messages: conversations[chatId],
  });
  const reply = r.content.find(b => b.type === "text")?.text || "Something went wrong.";
  conversations[chatId].push({ role: "assistant", content: reply });
  return reply;
}

async function handleChatGPT(text, system) {
  const sys = system || "You are a world-class creative director and copywriter for Company C, a premium cosmetics brand. Produce high-quality visual advertisement concepts, ad copy, social media content, and creative briefs.";
  const r = await openai.chat.completions.create({
    model: "gpt-4o", max_tokens: 1500,
    messages: [{ role: "system", content: sys }, { role: "user", content: text }],
  });
  return r.choices[0].message.content;
}

bot.onText(/\/start/, msg => {
  conversations[msg.chat.id] = [];
  bot.sendMessage(msg.chat.id,
    "Hi! I'm Mimi - GM of Company C.\n\nFull ChatGPT access for visual advertising:\n\n/ad [product] - Visual ad concept\n/social [brief] - Social media content\n/copy [brief] - Ad copywriting\n/brief [product] - Creative brief for the team\n/campaign [product] - Full campaign\n/status - Team status\n/clear - Reset\n\nOr just type - I auto-route to ChatGPT for creative work!"
  );
});

bot.onText(/\/help/, msg => {
  bot.sendMessage(msg.chat.id,
    "Mimi Bot Commands:\n\n/ad [product]\n/social [brief]\n/copy [brief]\n/brief [product]\n/campaign [product]\n/translate [text]\n/status\n/clear\n/myid\n\nJust type naturally - auto-routes to ChatGPT for creative work!"
  );
});

bot.onText(/\/clear/, msg => { conversations[msg.chat.id] = []; bot.sendMessage(msg.chat.id, "Cleared!"); });
bot.onText(/\/myid/, msg => { bot.sendMessage(msg.chat.id, "Your chat ID: " + msg.chat.id); });

bot.onText(/\/status/, msg => {
  bot.sendMessage(msg.chat.id, "Company C Team:\nMimi (GM) Online\nLara (Creative) Active\nZoe (Design) Active\nKai (Social) Active\n\nChatGPT: Full access | Claude: Strategy");
});

bot.onText(/\/ad (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Creating visual ad concept...");
  try {
    const reply = await handleChatGPT("Create a detailed visual advertisement concept for: " + match[1] + ". Include: headline, subheadline, visual description, color palette, mood, call to action, platform recommendations.", "You are a world-class creative director for Company C, a premium cosmetics brand.");
    bot.sendMessage(chatId, "Ad Concept:\n\n" + reply);
  } catch (err) { bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/social (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Creating social media content...");
  try {
    const reply = await handleChatGPT("Create engaging social media content for: " + match[1] + ". Provide versions for Instagram (caption + hashtags), TikTok (script/concept), Facebook (post copy). Make it trendy and on-brand for a premium cosmetics brand.", "You are a top social media strategist for Company C.");
    bot.sendMessage(chatId, "Social Media Content:\n\n" + reply);
  } catch (err) { bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/copy (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Writing ad copy...");
  try {
    const reply = await handleChatGPT("Write compelling ad copy for: " + match[1] + ". Include: long-form copy, short punchy version, tagline options, key selling points.", "You are an award-winning copywriter for Company C, a premium cosmetics brand.");
    bot.sendMessage(chatId, "Ad Copy:\n\n" + reply);
  } catch (err) { bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/brief (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Creating creative brief for the team...");
  try {
    const reply = await handleChatGPT("Create a detailed creative brief for the visual team (Creative Director, Graphic Designer, Social Media Lead) for: " + match[1] + ". Include: objective, target audience, key message, visual direction, deliverables, timeline suggestions.", "You are Mimi, GM of Company C. Create professional creative briefs for your visual team.");
    bot.sendMessage(chatId, "Creative Brief:\n\n" + reply);
  } catch (err) { bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/campaign (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Building full campaign concept...");
  try {
    const reply = await handleChatGPT("Create a full advertising campaign for: " + match[1] + ". Include: campaign name, theme, target audience, key visuals, channel strategy (Instagram/TikTok/Facebook), content calendar outline, KPIs.", "You are a senior brand strategist for Company C, a premium cosmetics brand.");
    bot.sendMessage(chatId, "Campaign Concept:\n\n" + reply);
  } catch (err) { bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.onText(/\/translate (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  try {
    const reply = await handleChatGPT("Translate this text, provide only the translation: " + match[1]);
    bot.sendMessage(chatId, "Translation:\n\n" + reply);
  } catch (err) { bot.sendMessage(chatId, "Error: " + err.message); }
});

bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const ai = detectAI(msg.text);
  bot.sendChatAction(chatId, "typing");
  try {
    if (ai === "chatgpt") {
      bot.sendMessage(chatId, "Routing to ChatGPT...");
      const reply = await handleChatGPT(msg.text);
      bot.sendMessage(chatId, "ChatGPT:\n\n" + reply);
    } else {
      const reply = await handleMimi(chatId, msg.text);
      bot.sendMessage(chatId, reply);
    }
  } catch (err) { bot.sendMessage(chatId, "Something went wrong. Please try again."); }
});

console.log("Mimi online - Claude + ChatGPT full creative access.");
