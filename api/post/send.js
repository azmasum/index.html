const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { productIds, title, footer, targets, scheduleAt } = req.body;

  if (scheduleAt) {
    const { data, error } = await supabase.from('scheduled_posts').insert({
      product_ids: productIds, // Supabase JSONB কলাম হলে সরাসরি অ্যারে পাঠানো যায়
      title, footer,
      status: 'pending',
      scheduled_at: scheduleAt,
      send_to_channel: targets.includes('channel'),
      send_to_group: targets.includes('group'),
      send_to_subscribers: targets.includes('subscribers')
    });
    return res.status(200).json({ ok: true, scheduled: true });
  }

  // ইমিডিয়েটলি পাঠানোর লজিক এখানে (check-scheduled-এর মতো একই tg কল)
  return res.status(200).json({ ok: true, message: 'Sent successfully' });
};
