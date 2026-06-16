const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

const TOKEN      = process.env.TG_BOT_TOKEN;
const CHANNEL_ID = '-1002210302760';
const GROUP_ID   = '-1004320220003';

// Telegram API calling helper
async function tg(method, body) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Build HTML Text for Telegram
function buildText(products, title, footer) {
  let text = `<b>${title || '🔥 বিশেষ অফার!'}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  products.forEach((p, i) => {
    const orig  = parseFloat(p.original_price) || 0;
    const curr  = parseFloat(p.price) || 0;
    const saved = orig > curr ? orig - curr : 0;
    const pct   = orig > 0 ? Math.round((saved / orig) * 100) : 0;

    text += `${i + 1}️⃣ <b>${p.name}</b>\n`;
    if (saved > 0) {
      // HTML style for strikethrough (<s>)
      text += `   <s>৳${orig.toLocaleString()}</s> → <b>৳${curr.toLocaleString()}</b>\n`;
      text += `   🔥 ৳${saved.toLocaleString()} ছাড় (${pct}% OFF)\n\n`;
    } else {
      text += `   💰 মাত্র <b>৳${curr.toLocaleString()}</b>\n\n`;
    }
  });

  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += footer || `🤖 @DarazDealBD_bot\n#DarazBD #Deal`;
  return text;
}

// Send Message/Photo to Chat
async function sendToChat(chatId, products, title, footer) {
  const text = buildText(products, title, footer);
  const buttons = products.map(p => ([{
    text: `🛒 ${p.name.substring(0, 30)}...`,
    url: p.daraz_link || 'https://www.daraz.com.bd'
  }]));
  buttons.push([{ text: '🤖 Bot এ আরো দেখুন', url: 'https://t.me/DarazDealBD_bot' }]);

  const firstImg = products.find(p => p.image_url);
  
  if (firstImg) {
    return tg('sendPhoto', {
      chat_id: chatId,
      photo: firstImg.image_url,
      caption: text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  }
  return tg('sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
}

module.exports = async function handler(req, res) {
  // Security Check
  const auth = req.headers['authorization'];
  const isVercelCron = req.headers['x-vercel-signature'] !== undefined;
  
  if (!isVercelCron && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date().toISOString();

  // ১. পেন্ডিং পোস্টগুলো খুঁজে বের করা
  const { data: posts, error: fetchError } = await supabase
    .from('scheduled_posts')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', now)
    .order('scheduled_at', { ascending: true })
    .limit(5); // Vercel Timeout এড়াতে লিমিট কমিয়ে ৫ করা হয়েছে

  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!posts?.length) return res.status(200).json({ ok: true, message: 'No pending posts' });

  const results = [];

  for (const post of posts) {
    // ২. প্রোডাক্ট আইডিগুলো বের করা (JSON Check)
    let productIds = post.product_ids;
    if (typeof productIds === 'string') {
        productIds = JSON.parse(productIds || '[]');
    }

    const { data: products } = await supabase
      .from('products')
      .select('*')
      .in('id', productIds)
      .eq('in_stock', true);

    if (!products?.length) {
      await supabase.from('scheduled_posts').update({ status: 'failed', sent_at: now }).eq('id', post.id);
      continue;
    }

    const postResults = [];

    // ৩. চ্যানেল এবং গ্রুপে পাঠানো
    if (post.send_to_channel) {
      const r = await sendToChat(CHANNEL_ID, products, post.title, post.footer);
      postResults.push({ target: 'channel', ok: r.ok });
    }

    if (post.send_to_group) {
      const r = await sendToChat(GROUP_ID, products, post.title, post.footer);
      postResults.push({ target: 'group', ok: r.ok });
    }

    // ৪. সাবস্ক্রাইবারদের পাঠানো (সতর্কতা: বেশি সাবস্ক্রাইবার থাকলে টাইমআউট হতে পারে)
    if (post.send_to_subscribers) {
      const { data: subs } = await supabase
        .from('subscribers')
        .select('user_id')
        .eq('subscribed', true);

      let count = 0;
      for (const sub of (subs || [])) {
        const text = buildText(products, post.title, post.footer);
        const r = await tg('sendMessage', { chat_id: sub.user_id, text, parse_mode: 'HTML' });
        if (r.ok) count++;
        // প্রতি মেসেজে সামান্য গ্যাপ (Rate Limit এড়াতে)
        await new Promise(r => setTimeout(r, 60)); 
      }
      postResults.push({ target: 'subscribers', count });
    }

    // ৫. স্ট্যাটাস আপডেট
    await supabase.from('scheduled_posts')
      .update({
        status: 'sent',
        sent_at: now,
        results: JSON.stringify(postResults)
      })
      .eq('id', post.id);

    // ৬. লগ ইনসার্ট
    await supabase.from('post_logs').insert({
      post_type: post.post_type || 'scheduled',
      targets: JSON.stringify(postResults.map(r => r.target)),
      product_count: products.length,
      results: JSON.stringify(postResults),
      posted_at: now
    });

    // ৭. এডমিন নোটিফিকেশন
    if (process.env.TG_ADMIN_CHAT_ID) {
      const okCount = postResults.filter(r => r.ok || r.count > 0).length;
      await tg('sendMessage', {
        chat_id: process.env.TG_ADMIN_CHAT_ID,
        text: `📅 <b>Scheduled Post Sent!</b>\n\n📦 পণ্য: ${products.length}টি\n✅ প্ল্যাটফর্ম: ${okCount}টি\n🕐 ${new Date().toLocaleString('bn-BD')}`,
        parse_mode: 'HTML'
      });
    }

    results.push({ postId: post.id, results: postResults });
  }

  return res.status(200).json({
    ok: true,
    processed: results.length,
    results
  });
};
