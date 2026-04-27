// ═══════════════════════════════════════════════════════════
// HustleAI Backend — server.js
// Stack: Node.js + Express + Supabase + Anthropic + Payfast
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const crypto      = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic   = require('@anthropic-ai/sdk');

const app = express();

// ── MIDDLEWARE ──────────────────────────────────────────────
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Payfast ITN sends urlencoded

// ── CLIENTS ─────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service key — never expose to frontend
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── HELPERS ─────────────────────────────────────────────────

// Payfast signature generator
function payfastSignature(data, passphrase) {
  // Sort keys alphabetically, build query string
  const str = Object.keys(data)
    .filter(k => k !== 'signature' && data[k] !== '')
    .sort()
    .map(k => `${k}=${encodeURIComponent(data[k]).replace(/%20/g, '+')}`)
    .join('&');
  const withPass = passphrase ? `${str}&passphrase=${encodeURIComponent(passphrase)}` : str;
  return crypto.createHash('md5').update(withPass).digest('hex');
}

// Build the AI prompt from quiz answers
function buildPrompt(answers, name) {
  const summary = Object.entries(answers)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('\n');

  return `You are a South African side hustle and small business advisor. ${name ? `The person's name is ${name}.` : ''} Create a highly personalised, actionable hustle plan based on this profile.

PROFILE:
${summary}

Structure your response EXACTLY like this:

## Your Top 3 Hustle Matches

### 🥇 Hustle #1 — [Name]
- **Why it fits you:** [specific reason based on their profile]
- **How to start in 7 days:** [3-4 concrete SA-specific steps]
- **Realistic income:** R[amount] – R[amount] per month within 90 days
- **SA platforms to use:** [specific: Facebook Marketplace, Takealot, Gumtree, Checkers Sixty60, WhatsApp Business, etc.]
- **Start-up cost:** R[amount]

### 🥈 Hustle #2 — [Name]
[same structure]

### 🥉 Hustle #3 — [Name]
[same structure]

## Your 30-Day Action Plan

**Week 1 — Setup**
[3-4 specific actions]

**Week 2 — Launch**
[3-4 specific actions]

**Week 3 — First sales**
[3-4 specific actions]

**Week 4 — Optimise**
[3-4 specific actions]

## Tools & Resources (Free or Cheap)
[List 5-6 SA-specific apps, platforms, tools with brief description]

## The Honest Reality Check
[One honest paragraph about realistic expectations, common mistakes, mindset required. Keep it warm but real.]

Rules:
- Use ZAR (R) for ALL money figures
- Reference SA-specific platforms only (no Etsy, no Fiverr as primary, etc.)
- Keep advice 100% relevant to the South African context
- Be direct, warm, and encouraging — not corporate or generic
- Address the person by their first name if provided`;
}

// ═══════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════

// ── GET /health ─────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── GET /api/stats ──────────────────────────────────────────
// Public stats for the landing page (visitor counter, plans generated)
app.get('/api/stats', async (req, res) => {
  try {
    const [visitorRes, plansRes] = await Promise.all([
      supabase.from('visitors').select('id', { count: 'exact', head: true }),
      supabase.from('payments').select('id', { count: 'exact', head: true }).eq('status', 'complete'),
    ]);
    res.json({
      visitors: visitorRes.count || 0,
      plans_generated: plansRes.count || 0,
    });
  } catch(e) {
    res.json({ visitors: 0, plans_generated: 0 });
  }
});

// ── POST /api/visitors ──────────────────────────────────────
// Register a new visitor (name + email captured on landing page)
app.post('/api/visitors', async (req, res) => {
  const { name, email, source } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // Check if email already exists
  const { data: existing } = await supabase
    .from('visitors')
    .select('id')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (existing) {
    // Update name in case they come back
    await supabase.from('visitors').update({ name, last_seen: new Date() }).eq('id', existing.id);
    return res.json({ id: existing.id, returning: true });
  }

  const { data, error } = await supabase.from('visitors').insert({
    name: name.trim(),
    email: email.toLowerCase().trim(),
    source: source || 'direct',
    ip_address: ip,
  }).select('id').single();

  if (error) return res.status(500).json({ error: 'Could not save visitor' });

  // Track initial step
  await supabase.from('sessions').insert({ visitor_id: data.id, step: 'capture', created_at: new Date() });

  res.json({ id: data.id });
});

// ── POST /api/track ─────────────────────────────────────────
// Track which step a visitor reached (for funnel analytics)
app.post('/api/track', async (req, res) => {
  const { visitor_id, step } = req.body;
  if (!visitor_id || !step) return res.status(400).json({ error: 'Missing fields' });

  await supabase.from('sessions').insert({
    visitor_id,
    step,
    created_at: new Date(),
  });

  // Update visitor's last known step
  await supabase.from('visitors').update({ last_step: step, last_seen: new Date() }).eq('id', visitor_id);

  res.json({ ok: true });
});

// ── POST /api/payment/create ────────────────────────────────
// Build signed Payfast form data and return to frontend
app.post('/api/payment/create', async (req, res) => {
  const { visitor_id, name, email, answers } = req.body;
  if (!visitor_id || !name || !email) return res.status(400).json({ error: 'Missing fields' });

  // Generate a unique payment ID
  const paymentId = `HUSTLE_${Date.now()}_${visitor_id.toString().slice(0, 8)}`;

  // Save answers and payment record to DB
  const { data: paymentRecord } = await supabase.from('payments').insert({
    visitor_id,
    m_payment_id: paymentId,
    amount: 97.00,
    status: 'pending',
    answers: answers, // JSONB column
  }).select('id').single();

  // Build Payfast fields
  const nameParts = name.trim().split(' ');
  const fields = {
    merchant_id:   process.env.PAYFAST_MERCHANT_ID,
    merchant_key:  process.env.PAYFAST_MERCHANT_KEY,
    return_url:    `${process.env.FRONTEND_URL}/results.html?session_id=${paymentRecord.id}`,
    cancel_url:    `${process.env.FRONTEND_URL}/index.html?cancelled=1`,
    notify_url:    `${process.env.BACKEND_URL}/api/payment/notify`,
    name_first:    nameParts[0],
    name_last:     nameParts[1] || '',
    email_address: email,
    m_payment_id:  paymentId,
    amount:        '97.00',
    item_name:     'HustleAI — SA Side Hustle Plan',
    item_description: 'Personalised South African side hustle and business plan',
  };

  fields.signature = payfastSignature(fields, process.env.PAYFAST_PASSPHRASE);

  const isSandbox = process.env.PAYFAST_SANDBOX === 'true';
  const payfastUrl = isSandbox
    ? 'https://sandbox.payfast.co.za/eng/process'
    : 'https://www.payfast.co.za/eng/process';

  res.json({ payfast_url: payfastUrl, fields });
});

// ── POST /api/payment/notify ────────────────────────────────
// Payfast ITN (Instant Transaction Notification) webhook
// Payfast calls this server-to-server when payment is confirmed
app.post('/api/payment/notify', async (req, res) => {
  const data = req.body;

  // Step 1: Verify signature
  const receivedSig = data.signature;
  const calculatedSig = payfastSignature(data, process.env.PAYFAST_PASSPHRASE);
  if (receivedSig !== calculatedSig) {
    console.error('Payfast signature mismatch');
    return res.status(400).send('Invalid signature');
  }

  // Step 2: Check payment status
  if (data.payment_status !== 'COMPLETE') {
    return res.status(200).send('OK'); // Acknowledge but don't process
  }

  // Step 3: Find the payment record by m_payment_id
  const { data: payment } = await supabase
    .from('payments')
    .select('id, visitor_id')
    .eq('m_payment_id', data.m_payment_id)
    .single();

  if (!payment) return res.status(404).send('Payment not found');

  // Step 4: Mark as complete
  await supabase.from('payments').update({
    status: 'complete',
    payfast_payment_id: data.pf_payment_id,
    completed_at: new Date(),
  }).eq('id', payment.id);

  // Step 5: Track conversion
  await supabase.from('sessions').insert({
    visitor_id: payment.visitor_id,
    step: 'payment_complete',
    created_at: new Date(),
  });
  await supabase.from('visitors').update({ converted: true, last_step: 'payment_complete' }).eq('id', payment.visitor_id);

  res.status(200).send('OK');
});

// ── GET /api/payment/verify/:sessionId ──────────────────────
// Frontend calls this to check if a payment session is valid before generating plan
app.get('/api/payment/verify/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  const { data: payment } = await supabase
    .from('payments')
    .select('id, status, answers, visitor_id, visitors(name, email)')
    .eq('id', sessionId)
    .single();

  if (!payment) return res.status(404).json({ error: 'Session not found' });
  if (payment.status !== 'complete') return res.status(402).json({ error: 'Payment not complete' });

  res.json({
    id: payment.id,
    name: payment.visitors?.name,
    answers: payment.answers,
  });
});

// ── POST /api/generate ──────────────────────────────────────
// Generate AI plan — only callable with a verified payment session
// Streams the response back to the frontend
app.post('/api/generate', async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'Session ID required' });

  // Verify payment
  const { data: payment } = await supabase
    .from('payments')
    .select('id, status, answers, plan_generated, visitor_id, visitors(name)')
    .eq('id', session_id)
    .single();

  if (!payment || payment.status !== 'complete') {
    return res.status(402).json({ error: 'Valid payment required' });
  }

  const name = payment.visitors?.name || '';
  const prompt = buildPrompt(payment.answers || {}, name);

  // Set up streaming headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let fullPlan = '';

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    stream.on('text', (text) => {
      fullPlan += text;
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    });

    await stream.finalMessage();

    // Save generated plan to DB
    await supabase.from('payments').update({
      plan_text: fullPlan,
      plan_generated: true,
      plan_generated_at: new Date(),
    }).eq('id', session_id);

    res.write('data: [DONE]\n\n');
    res.end();
  } catch(e) {
    console.error('Generation error:', e);
    res.write(`data: ${JSON.stringify({ error: 'Generation failed' })}\n\n`);
    res.end();
  }
});

// ═══════════════════════════════════════════════════════════
// ADMIN ROUTES (protected by API key)
// ═══════════════════════════════════════════════════════════

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  next();
}

// ── POST /api/admin/login ───────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ token: process.env.ADMIN_SECRET_KEY });
});

// ── GET /api/admin/stats ────────────────────────────────────
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const [visitors, payments, today_visitors, today_payments] = await Promise.all([
    supabase.from('visitors').select('id', { count: 'exact', head: true }),
    supabase.from('payments').select('id, amount', { count: 'exact' }).eq('status', 'complete'),
    supabase.from('visitors').select('id', { count: 'exact', head: true })
      .gte('created_at', new Date(new Date().setHours(0,0,0,0)).toISOString()),
    supabase.from('payments').select('id', { count: 'exact', head: true })
      .eq('status', 'complete')
      .gte('completed_at', new Date(new Date().setHours(0,0,0,0)).toISOString()),
  ]);

  // Total revenue
  const { data: revenueData } = await supabase
    .from('payments')
    .select('amount')
    .eq('status', 'complete');
  const total_revenue = (revenueData || []).reduce((s, p) => s + Number(p.amount), 0);

  res.json({
    total_visitors: visitors.count || 0,
    total_conversions: payments.count || 0,
    total_revenue,
    conversion_rate: visitors.count ? ((payments.count / visitors.count) * 100).toFixed(1) : '0',
    today_visitors: today_visitors.count || 0,
    today_conversions: today_payments.count || 0,
  });
});

// ── GET /api/admin/funnel ───────────────────────────────────
app.get('/api/admin/funnel', requireAdmin, async (req, res) => {
  const steps = ['capture', 'quiz_step_0', 'quiz_step_1', 'quiz_step_2', 'quiz_step_3', 'quiz_step_4', 'preview', 'payment_complete'];

  const counts = await Promise.all(
    steps.map(async (step) => {
      const { count } = await supabase
        .from('sessions')
        .select('visitor_id', { count: 'exact', head: true })
        .eq('step', step);
      return { step, count: count || 0 };
    })
  );

  res.json(counts);
});

// ── GET /api/admin/visitors ─────────────────────────────────
app.get('/api/admin/visitors', requireAdmin, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  const { data, error } = await supabase
    .from('visitors')
    .select('id, name, email, source, last_step, converted, created_at')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/admin/revenue ──────────────────────────────────
app.get('/api/admin/revenue', requireAdmin, async (req, res) => {
  // Last 30 days daily revenue
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('payments')
    .select('amount, completed_at')
    .eq('status', 'complete')
    .gte('completed_at', thirtyDaysAgo)
    .order('completed_at');

  // Group by day
  const byDay = {};
  (data || []).forEach(p => {
    const day = p.completed_at?.split('T')[0];
    if (day) byDay[day] = (byDay[day] || 0) + Number(p.amount);
  });

  res.json(Object.entries(byDay).map(([date, revenue]) => ({ date, revenue })));
});

// ── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HustleAI backend running on port ${PORT}`));

module.exports = app;
