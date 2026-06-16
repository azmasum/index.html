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

module.exports = async function handler(req, res) {
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).send('Unauthorized');

  const now = new Date().toISOString();
  const { data: posts } = await supabase.from('scheduled_posts')
    .select('*').eq('status', 'pending').lte('scheduled_at', now).limit(3);

  if (!posts?.length) return res.status(200).json({ message: 'No pending posts' });

  for (const post of posts) {
    const pIds = Array.isArray(post.product_ids) ? post.product_ids : JSON.parse(post.product_ids || '[]');
    const { data: products } = await supabase.from('products').select('*').in('id', pIds);

    if (products?.length) {
      let text = `<b>${post.title || '🔥 বিশেষ অফার!'}</b>\n\n`;
      products.forEach((p, i) => {
        const orig = parseFloat(p.original_price) || 0;
        const curr = parseFloat(p.price) || 0;
        text += `${i+1}. <b>${p.name}</b>\n   ৳${curr.toLocaleString()} ${orig > curr ? `(<s>৳${orig.toLocaleString()}</s>)` : ''}\n\n`;
      });
      text += post.footer || '🤖 @DarazDealBD_bot';

      if (post.send_to_channel) {
        await tg('sendMessage', { chat_id: process.env.TG_CHANNEL_ID, text, parse_mode: 'HTML' });
      }
    }
    await supabase.from('scheduled_posts').update({ status: 'sent', sent_at: now }).eq('id', post.id);
  }
  return res.status(200).json({ ok: true });
};
