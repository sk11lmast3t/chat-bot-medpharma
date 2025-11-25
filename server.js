// server.js - Complete Karachi Pharmacy Bot (Grok-style baat karega!)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { WebhookClient, Suggestion } = require('dialogflow-fulfillment');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Supabase + Gemini
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Global state for collecting user info
const USER_STATE = {};

 const GROK_STYLE_PROMPT = `You are MedBot, a helpful Pakistani pharmacy assistant for MedEasy Pharmacy in Karachi.
Speak in Roman Urdu + English mix (like Karachi people talk).
Rules:
- NEVER diagnose, prescribe, or give dosage.
- For medical questions (bimar hoon, pain, dosage): Say "Sorry bhai, main doctor nahi. Pharmacist se baat karo? Main connect kar dun."
- If query in Urdu (bimar, dawai, parchi): Reply in Roman Urdu.
- Be fun, empathetic, like a friend: Use "bhai", "yar", "theek hai".
- If low confidence, ask to repeat in English or Urdu.`;

app.post('/webhook', async (req, res) => {
  const agent = new WebhookClient({ request: req, response: res });
  const sessionId = agent.session.split('/').pop();

  const log = async (sender, text) => {
    await supabase.from('messages').insert({ session_id: sessionId, sender, text }).catch(() => {});
  };

 const geminiReply = async (query) => {
  try {
    // Simple Urdu detection (add more words as needed)
    const isUrdu = /bimar|dawai|parchi|dosage|pain|khurak/i.test(query);
    let prompt = GROK_STYLE_PROMPT;
    if (isUrdu) {
      prompt += `\nUser query in Urdu: ${query}. Reply in Roman Urdu.`;
    }
    const chat = model.startChat({
      history: [{ role: "model", parts: [{ text: prompt }] }]
    });
    const result = await chat.sendMessage(query);
    let reply = result.response.text();
    
    // Safety for medical
    if (/bimar|sick|pain|dosage|side effect/i.test(reply.toLowerCase())) {
      reply = "Sorry bhai, main medical advice nahi de sakta. Kya pharmacist se connect kar dun? (Yes/No)";
    }
    return reply;
  } catch (e) {
    return "Yar, thodi problem aa gayi. Pharmacist se baat karo?";
  }
};

  // Welcome
  async function welcome() {
    agent.add(`السلام علیکم یار! میڈ ایزی فارمیسی میں خوش آمدید 

کیا حال ہے؟ آج کون سی دوائی چاہیے؟ 😄

• نیا آرڈر شروع کریں
• پرچی اپ لوڈ کریں
• فارماسسٹ سے بات کریں`);

    agent.add(new Suggestion('نیا آرڈر شروع کریں'));
    agent.add(new Suggestion('پرچی اپ لوڈ کریں'));
    agent.add(new Suggestion('فارماسسٹ سے بات کریں'));
  }

  // Start collecting user info
  async function startOrdering() {
    USER_STATE[sessionId] = { step: 'phone', data: {} };
    agent.add(`واہ بھائی! نیا آرڈر کرنے کا موڈ ہے؟ 🔥

پہلے اپنا موبائل نمبر بتا دو (11 ڈیجٹ)\nمثال: 03331234567`);
  }

  // Collect details step by step
  async function collectDetails() {
    if (!USER_STATE[sessionId]) return;

    const input = agent.query.trim();
    const state = USER_STATE[sessionId];

    if (state.step === 'phone') {
      if (!/^(03[0-4]\d{8})$/.test(input.replace(/[-\s]/g,''))) {
        agent.add("بھائی درست نمبر بھیجو نا 😅\nمثال: 03331234567");
        return;
      }
      state.data.phone = input.replace(/[-\s]/g,'');
      state.step = 'name';
      agent.add(`اوکے ${state.data.phone} سیو! 

اب پورا نام بتا دو یار ✍️`);
    }
    else if (state.step === 'name') {
      state.data.name = input;
      state.step = 'email';
      agent.add(`واہ ${input} بہت اچھا نام ہے! 

ای میل بتا دو (یا "skip" لکھ دو)`);
    }
    else if (state.step === 'email') {
      state.data.email = (input.toLowerCase() === 'skip') ? null : input;
      state.step = 'address';
      agent.add(`ٹھیک ہے! 

اب ڈلیوری ایڈریس بتا دو (گلی، سیکٹر، گھر نمبر)\nیا "skip" لکھ دو`);
    }
    else if (state.step === 'address') {
      state.data.address = (input.toLowerCase() !== 'skip') ? input : null;

      // Save to Supabase
      await supabase.from('profiles').upsert({
        phone: state.data.phone,
        full_name: state.data.name,
        email: state.data.email,
        address: state.data.address,
        city: "Karachi",
        updated_at: new Date()
      });

      delete USER_STATE[sessionId];

      agent.add(`بھائی سب ڈیٹا سیو ہو گیا! 

اب بتاؤ کیا چاہیے؟
• پرچی اپ لوڈ کروائیں؟
• کوئی دوائی سرچ کریں؟
• فارماسسٹ سے بات کریں؟`);

      agent.add(new Suggestion('پرچی اپ لوڈ کریں'));
      agent.add(new Suggestion('فارماسسٹ سے بات کریں'));
    }
  }

  // Prescription upload
  async function uploadPrescription() {
    const fileName = `${sessionId}/${uuidv4()}.jpg`;
    const { data } = await supabase.storage.from('prescriptions').createSignedUploadUrl(fileName);
    agent.add(`بھائی پرچی کی واضح تصویر یہاں اپ لوڈ کر دو 

${data.signedUrl}

5-10 منٹ میں چیک کر کے بتا دیں گے!`);
  }

  // Talk to pharmacist
  async function talkToPharmacist() {
    await supabase.from('conversations').upsert({ session_id: sessionId, needs_human: true });
    agent.add("بھائی ابھی رجسٹرڈ فارماسسٹ کو بلا رہا ہوں... 1-2 منٹ لگے گا، انتظار کرو!");
  }

  // Fallback → Grok style reply
  async function fallback() {
    await log('user', agent.query);
    const reply = await geminiReply(agent.query);
    agent.add(reply);
    await log('bot', reply);
  }

  // Intent Map
  const intentMap = new Map();
  intentMap.set('Default Welcome Intent', welcome);
  intentMap.set('start.ordering', startOrdering);
  intentMap.set('prescription.upload', uploadPrescription);
  intentMap.set('talk.to.pharmacist', talkToPharmacist);
  intentMap.set('Default Fallback Intent', async (agent) => {
    if (USER_STATE[sessionId]) {
      await collectDetails(agent);
    } else {
      await fallback(agent);
    }
  });

  agent.handleRequest(intentMap);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`بھائی تمہارا Grok جیسا بوٹ LIVE ہے!`);
  console.log(`http://localhost:${PORT}`);
  console.log(`ngrok چلاؤ: npx ngrok http ${PORT}`);
});
