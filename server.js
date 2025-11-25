

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

// Global state for user data collection
const USER_STATE = {};

// Log messages to Supabase
const log = async (sessionId, sender, text) => {
  await supabase.from('messages').insert({ session_id: sessionId, sender, text }).catch(() => {});
};

// Gemini reply with Urdu detection
const geminiReply = async (query) => {
  try {
    const isUrdu = /bimar|dawai|parchi|pharmacist|doctor|pain|urgent|khurak|order|bhai|yar|skip/i.test(query);
    const prompt = isUrdu 
      ? `User ne Roman Urdu mein bola: "${query}". Karachi style Roman Urdu mein funny aur dostana reply karo. Medical advice bilkul mat dena.`
      : `User ne English mein bola: "${query}". Normal English mein reply karo.`;

    const result = await model.generateContent(prompt + "\nSirf ek message mein reply karo.");
    return result.response.text() || "Sorry bhai, samajh nahi aaya.";
  } catch (e) {
    return "Yar network mein masla hai, pharmacist se baat karo?";
  }
};

// Welcome
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

// Start order → collect data
async function startOrdering(agent) {
  const sessionId = agent.session.split('/').pop();
  USER_STATE[sessionId] = { step: 'phone', data: {} };
  agent.add(`Wah bhai! Order ka mood hai?

Pehle mobile number daal do (11 digit)\nExample: 03331234567`);
}

// Collect user data step by step
async function collectDetails(agent) {
  const sessionId = agent.session.split('/').pop();
  const state = USER_STATE[sessionId];
  if (!state) return;

  const input = agent.query.trim();

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
  else if (state.step === 'name') {
    state.data.name = input;
    state.step = 'email';
    agent.add(`Wah ${input} bohot acha naam hai!

Email daal do ya "skip" likh do`);
  }
  else if (state.step === 'email') {
    state.data.email = input.toLowerCase() === 'skip' ? null : input;
    state.step = 'address';
    agent.add(`Email save!

Ab delivery address daal do (ghar no, gali, area)\nya "skip" likh do`);
  }
  else if (state.step === 'address') {
    state.data.address = input.toLowerCase() !== 'skip' ? input : null;

    await supabase.from('profiles').upsert({
      phone: state.data.phone,
      full_name: state.data.name,
      email: state.data.email,
      address: state.data.address,
      city: "Karachi",
      updated_at: new Date()
    });

    delete USER_STATE[sessionId];

    agent.add(`Bhai sab data save ho gaya!

Ab batao kya karna hai?
• Parchi upload karo
• Pharmacist se baat
• Dawai search karo`);

    agent.add(new Suggestion('Parchi upload karo'));
    agent.add(new Suggestion('Pharmacist se baat'));
  }
}

// Prescription upload
async function uploadPrescription(agent) {
  const sessionId = agent.session.split('/').pop();
  const fileName = `${sessionId}/${uuidv4()}.jpg`;
  const { data } = await supabase.storage.from('prescriptions').createSignedUploadUrl(fileName);

  agent.add(`Bhai parchi ki clear photo yahan upload kar do

${data.signedUrl}

5-10 min mein check kar ke bata denge!`);
}
async function medicineSearch(agent) {
  agent.add(`Bhai konsi dawai dhundni hai? Naam batao (jaise Panadol, Dolo 650, etc)\nYa generic name bhi chalega`);

// Pharmacist handover
async function talkToPharmacist(agent) {
  const sessionId = agent.session.split('/').pop();

  await supabase.from('conversations').upsert({
    session_id: sessionId,
    needs_human: true,
    phone: USER_STATE[sessionId]?.data?.phone || null
  });

  agent.add(`Theek hai bhai, pharmacist se connect kar raha hun...
1 minute wait karo, jaldi aa jayega`);
}

// Fallback with auto-handover
async function fallback(agent) {
  await log(agent.session.split('/').pop(), 'user', agent.query);

  // Medical/Urdu keywords → direct handover
  if (/bimar|dawai|parchi|pharmacist|doctor|pain|urgent|khurak|order|bhai|yar|skip/i.test(agent.query)) {
    await talkToPharmacist(agent);
    return;
  }

  const reply = await geminiReply(agent.query);
  agent.add(reply);
  await log(agent.session.split('/').pop(), 'bot', reply);
}

// Webhook route
app.post('/webhook', async (req, res) => {
  const agent = new WebhookClient({ request: req, response: res });
  const sessionId = agent.session.split('/').pop();

  const intentMap = new Map();
  intentMap.set('Default Welcome Intent', welcome);
  intentMap.set('start.ordering', startOrdering);
  intentMap.set('prescription.upload', uploadPrescription);
  intentMap.set('talk.to.pharmacist', talkToPharmacist);
 intentMap.set('medicine.search', medicineSearch);

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
  console.log(`Bhai tumhara Grok jaisa bot LIVE hai! Port: ${PORT}`);
  console.log(`ngrok chalao: npx ngrok http ${PORT}`);
});
