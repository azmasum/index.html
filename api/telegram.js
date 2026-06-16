const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TOKEN = process.env.TG_BOT_TOKEN;

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

function formatCard(p, userId) {
  const orig = parseFloat(p.original_price) || 0;
  const curr = parseFloat(p.price) || 0;
  const saved = orig > curr ? orig - curr : 0;
  const pct = orig > 0 ? Math.round((saved / orig) * 100) : 0;
  
  // HTML Formatting for better stability
  let text = `<b>🛍️ ${p.name}</b>\n━━━━━━━━━━━━━━━\n`;
  if (saved > 0) {
    text += `<s>৳${orig.toLocaleString()}</s> → <b>৳${curr.toLocaleString()}</b>\n`;
    text += `🔥 ৳${saved.toLocaleString()} ছাড় (${pct}% OFF)\n`;
  } else {
    text += `💰 মূল্য: <b>৳${curr.toLocaleString()}</b>\n`;
  }
  text += `⭐ ${p.rating || 4.5} রেটিং | 🏷️ ${p.brand || 'No Brand'}\n`;
  text += `📂 ${p.category_label || p.category}`;
  
  return text;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');
  const { message, callback_query } = req.body;

  if (message?.text === '/start') {
    await tg('sendMessage', {
      chat_id: message.chat.id,
      text: `👋 <b>স্বাগতম ${message.from.first_name}!</b>\nDaraz-এর সেরা অফার পেতে নিচে খুঁজুন।`,
      parse_mode: 'HTML'
    });
  }
  // অন্যান্য কমান্ড আগের মতোই থাকবে...
  return res.status(200).json({ ok: true });
};
