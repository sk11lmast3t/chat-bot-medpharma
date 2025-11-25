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
 // GLOBAL STATE – USER KA DATA YAHAN STORE HOGA
const USER_STATE = {};

// WELCOME MESSAGE
async function welcome(agent) {
  agent.add(`Assalamualaikum bhai! MedEasy Pharmacy mein khush aamdeed

Kya haal hai? Aaj kya chahiye?

• Naya order shuru karo
• Parchi upload karo
• Pharmacist se baat karo`);

  agent.add(new Suggestion('Naya order shuru karo'));
  agent.add(new Suggestion('Parchi upload karo'));
  agent.add(new Suggestion('Pharmacist se baat karo'));
}

// JAB USER BOLE "NAYA ORDER" YA BUTTON DABAYE
async function startOrdering(agent) {
  const sessionId = agent.session.split('/').pop();
  USER_STATE[sessionId] = { step: 'phone', data: {} };

  agent.add(`Wah bhai! Order ka mood hai?

Pehle apna mobile number daal do (11 digit)\nExample: 03331234567`);
}

// DATA COLLECTION – HAR NEXT MESSAGE YAHAN AAYEGA
async function collectDetails(agent) {
  const sessionId = agent.session.split('/').pop();
  const state = USER_STATE[sessionId];
  if (!state) return;

  const input = agent.query.trim();

  // 1. PHONE
  if (state.step === 'phone') {
    const clean = input.replace(/[-\s]/g, '');
    if (!/^03[0-4]\d{8}$/.test(clean)) {
      agent.add("Bhai sahi number daal do na\nExample: 03331234567");
      return;
    }
    state.data.phone = clean;
    state.step = 'name';
    agent.add(`Number save ho gaya ${clean}!

Ab apna pura naam bata do`);
  }

  // 2. NAME
  else if (state.step === 'name') {
    state.data.name = input;
    state.step = 'email';
    agent.add(`Wah ${input} bohot acha naam hai!

Email daal do (order update ke liye) ya "skip" likh do`);
  }

  // 3. EMAIL
  else if (state.step === 'email') {
    state.data.email = input.toLowerCase() === 'skip' ? null : input;
    state.step = 'address';
    agent.add(`Email save!

Ab delivery address daal do (ghar no, gali, area)\nya "skip" likh do`);
  }

  // 4. ADDRESS + FINAL SAVE + CLEANUP
  else if (state.step === 'address') {
    state.data.address = input.toLowerCase() !== 'skip' ? input : null;

    // SUPABASE MEIN SAVE
    await supabase.from('profiles').upsert({
      phone: state.data.phone,
      full_name: state.data.name,
      email: state.data.email,
      address: state.data.address,
      city: "Karachi",
      updated_at: new Date()
    });

    delete USER_STATE[sessionId]; // session khatam

    agent.add(`Bhai sab data save ho gaya!

Ab batao kya karna hai?
• Parchi upload karo
• Pharmacist se baat
• Dawai search karo`);

    agent.add(new Suggestion('Parchi upload karo'));
    agent.add(new Suggestion('Pharmacist se baat'));
  }
}

// PHARMACIST HANDOVER – YE AB ATKEGA NAHI
async function talkToPharmacist(agent) {
  const sessionId = agent.session.split('/').pop();

  await supabase.from('conversations').upsert({
    session_id: sessionId,
    needs_human: true,
    phone: USER_STATE[sessionId]?.data?.phone || null
  });

  agent.add(`Theek hai bhai, pharmacist se connect kar raha hun...
1 minute wait karo, bohot jaldi aa jayega`);
}

// INTENT MAP – YE SABSE ZAROORI HAI
intentMap.set('Default Welcome Intent', welcome);
intentMap.set('start.ordering', startOrdering);           // ye intent Dialogflow mein banao
intentMap.set('talk.to.pharmacist', talkToPharmacist);   // ye bhi banao

// FALLBACK – DATA COLLECTION + NORMAL GEMINI
intentMap.set('Default Fallback Intent', async (agent) => {
  const sessionId = agent.session.split('/').pop();

  // agar data collection chal raha ho
  if (USER_STATE[sessionId]) {
    await collectDetails(agent);
    return;
  }

  // agar user ne "pharmacist" ya medical keyword bola ho
  if (/pharmacist|doctor|human|bimar|urgent|pain|dosage|khurak|side effect/i.test(agent.query)) {
    await talkToPharmacist(agent);
    return;
  }

  // warna normal Gemini fallback
  await fallback(agent);
});
  // Prescription upload
  async function uploadPrescription() {
    const fileName = `${sessionId}/${uuidv4()}.jpg`;
    const { data } = await supabase.storage.from('prescriptions').createSignedUploadUrl(fileName);
    agent.add(`بھائی پرچی کی واضح تصویر یہاں اپ لوڈ کر دو 

${data.signedUrl}

5-10 منٹ میں چیک کر کے بتا دیں گے!`);
  }

  // Talk to pharmacist
  aasync function talkToPharmacist() {
  await supabase.from('conversations').upsert({ 
    session_id: sessionId, 
    needs_human: true,
    phone: USER_STATE[sessionId]?.data?.phone || null
  });
  agent.add("Theek hai bhai, pharmacist se connect kar raha hoon. 1 minute wait karo…");
  await log('bot', 'Pharmacist handover triggered');
}

  // Fallback → Grok style reply
 // Auto handover on medical keywords
if (/bimar|doctor|pharmacist|urgent|pain|dosage|side effect|khurak/i.test(agent.query.toLowerCase())) {
  await talkToPharmacist(agent);
  return;
}
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
