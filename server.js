
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-6';

function buildPrompt(answers, name) {
  const summary = Object.entries(answers)
    .map(function(entry) {
      var k = entry[0];
      var v = entry[1];
      return k + ': ' + (Array.isArray(v) ? v.join(', ') : v);
    })
    .join('\n');

  return 'You are a South African side hustle and small business advisor. ' +
    (name ? 'The person\'s name is ' + name + '.' : '') +
    ' Create a highly personalised, actionable hustle plan based on this profile.\n\n' +
    'PROFILE:\n' + summary + '\n\n' +
    'Structure your response EXACTLY like this:\n\n' +
    '## Your Top 3 Hustle Matches\n\n' +
    '### Hustle #1 - [Name]\n' +
    '- Why it fits you: [specific reason]\n' +
    '- How to start in 7 days: [SA-specific steps]\n' +
    '- Realistic income: R[amount] per month within 90 days\n' +
    '- SA platforms to use: [Facebook Marketplace, Takealot, Gumtree, WhatsApp Business, etc]\n' +
    '- Start-up cost: R[amount]\n\n' +
    '### Hustle #2 - [Name]\n' +
    '[same structure]\n\n' +
    '### Hustle #3 - [Name]\n' +
    '[same structure]\n\n' +
    '## Your 30-Day Action Plan\n\n' +
    'Week 1 - Setup: [3-4 specific actions]\n' +
    'Week 2 - Launch: [3-4 specific actions]\n' +
    'Week 3 - First sales: [3-4 specific actions]\n' +
    'Week 4 - Optimise: [3-4 specific actions]\n\n' +
    '## Tools and Resources\n' +
    '[5-6 SA-specific apps and platforms with brief description]\n\n' +
    '## The Honest Reality Check\n' +
    '[One honest paragraph about expectations, common mistakes, mindset needed.]\n\n' +
    'Rules: Use ZAR for all money. SA-specific advice only. Be direct and warm.';
}

function payfastSignature(data, passphrase) {
  var str = Object.keys(data)
    .filter(function(k) { return k !== 'signature' && data[k] !== ''; })
    .sort()
    .map(function(k) { return k + '=' + encodeURIComponent(data[k]).replace(/%20/g, '+'); })
    .join('&');
  var withPass = passphrase ? str + '&passphrase=' + encodeURIComponent(passphrase) : str;
  return crypto.createHash('md5').update(withPass).digest('hex');
}

// ── HEALTH ──────────────────────────────────────────────────
app.get('/health', function(req, res) {
  res.json({ status: 'ok', time: new Date() });
});

// ── STATS ───────────────────────────────────────────────────
app.get('/api/stats', async function(req, res) {
  try {
    var visitorRes = await supabase.from('visitors').select('id', { count: 'exact', head: true });
    var plansRes = await supabase.from('payments').select('id', { count: 'exact', head: true }).eq('status', 'complete');
    res.json({ visitors: visitorRes.count || 0, plans_generated: plansRes.count || 0 });
  } catch(e) {
    res.json({ visitors: 0, plans_generated: 0 });
  }
});

// ── REGISTER VISITOR ────────────────────────────────────────
app.post('/api/visitors', async function(req, res) {
  var name = req.body.name;
  var email = req.body.email;
  var source = req.body.source;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

  try {
    var existing = await supabase.from('visitors').select('id').eq('email', email.toLowerCase().trim()).single();
    if (existing.data) {
      await supabase.from('visitors').update({ name: name, last_seen: new Date() }).eq('id', existing.data.id);
      return res.json({ id: existing.data.id, returning: true });
    }
    var result = await supabase.from('visitors').insert({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      source: source || 'direct',
    }).select('id').single();
    if (result.error) return res.status(500).json({ error: 'Could not save visitor' });
    res.json({ id: result.data.id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TRACK STEP ──────────────────────────────────────────────
app.post('/api/track', async function(req, res) {
  var visitor_id = req.body.visitor_id;
  var step = req.body.step;
  if (!visitor_id || !step) return res.status(400).json({ error: 'Missing fields' });
  try {
    await supabase.from('sessions').insert({ visitor_id: visitor_id, step: step, created_at: new Date() });
    await supabase.from('visitors').update({ last_step: step, last_seen: new Date() }).eq('id', visitor_id);
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: true });
  }
});

// ── GENERATE FREE (promo code users) ────────────────────────
app.post('/api/generate-free', async function(req, res) {
  var answers = req.body.answers;
  var name = req.body.name || '';
  if (!answers) return res.status(400).json({ error: 'Missing answers' });

  var prompt = buildPrompt(answers, name);

  try {
    var message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });
    var text = message.content[0].text;
    console.log('Generated plan for ' + (name || 'unknown') + ' - length: ' + text.length);
    res.json({ text: text });
  } catch(e) {
    console.error('Generate-free error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PAYMENT CREATE ───────────────────────────────────────────
app.post('/api/payment/create', async function(req, res) {
  var visitor_id = req.body.visitor_id;
  var name = req.body.name;
  var email = req.body.email;
  var answers = req.body.answers;
  if (!name || !email) return res.status(400).json({ error: 'Missing fields' });

  var paymentId = 'HUSTLE_' + Date.now() + '_' + (visitor_id || 'guest').toString().slice(0, 8);

  try {
    var paymentRecord = await supabase.from('payments').insert({
      visitor_id: visitor_id,
      m_payment_id: paymentId,
      amount: 97.00,
      status: 'pending',
      answers: answers,
    }).select('id').single();

    var nameParts = name.trim().split(' ');
    var fields = {
      merchant_id:   process.env.PAYFAST_MERCHANT_ID,
      merchant_key:  process.env.PAYFAST_MERCHANT_KEY,
      return_url:    (process.env.FRONTEND_URL || 'https://forgesystems-hustle.netlify.app') + '/results.html?session_id=' + paymentRecord.data.id,
      cancel_url:    (process.env.FRONTEND_URL || 'https://forgesystems-hustle.netlify.app'),
      notify_url:    (process.env.BACKEND_URL || 'https://hustleai-backend-production-edd6.up.railway.app') + '/api/payment/notify',
      name_first:    nameParts[0],
      name_last:     nameParts[1] || '',
      email_address: email,
      m_payment_id:  paymentId,
      amount:        '97.00',
      item_name:     'HustleAI SA Side Hustle Plan',
    };

    var isSandbox = process.env.PAYFAST_SANDBOX === 'true';
    var payfastUrl = isSandbox ? 'https://sandbox.payfast.co.za/eng/process' : 'https://www.payfast.co.za/eng/process';
    res.json({ payfast_url: payfastUrl, fields: fields });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PAYMENT NOTIFY (Payfast ITN webhook) ────────────────────
app.post('/api/payment/notify', async function(req, res) {
  var data = req.body;
  if (data.payment_status !== 'COMPLETE') return res.status(200).send('OK');
  try {
    var payment = await supabase.from('payments').select('id, visitor_id').eq('m_payment_id', data.m_payment_id).single();
    if (!payment.data) return res.status(404).send('Not found');
    await supabase.from('payments').update({ status: 'complete', completed_at: new Date() }).eq('id', payment.data.id);
    await supabase.from('visitors').update({ converted: true, last_step: 'payment_complete' }).eq('id', payment.data.visitor_id);
    res.status(200).send('OK');
  } catch(e) {
    res.status(200).send('OK');
  }
});

// ── PAYMENT VERIFY ───────────────────────────────────────────
app.get('/api/payment/verify/:sessionId', async function(req, res) {
  try {
    var payment = await supabase.from('payments').select('id, status, answers, visitor_id, visitors(name, email)').eq('id', req.params.sessionId).single();
    if (!payment.data) return res.status(404).json({ error: 'Session not found' });
    if (payment.data.status !== 'complete') return res.status(402).json({ error: 'Payment not complete' });
    res.json({ id: payment.data.id, name: payment.data.visitors && payment.data.visitors.name, answers: payment.data.answers });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GENERATE (paid users) ────────────────────────────────────
app.post('/api/generate', async function(req, res) {
  var session_id = req.body.session_id;
  if (!session_id) return res.status(400).json({ error: 'Session ID required' });
  try {
    var payment = await supabase.from('payments').select('id, status, answers, visitor_id, visitors(name)').eq('id', session_id).single();
    if (!payment.data || payment.data.status !== 'complete') return res.status(402).json({ error: 'Valid payment required' });
    var name = (payment.data.visitors && payment.data.visitors.name) || '';
    var prompt = buildPrompt(payment.data.answers || {}, name);
    var message = await anthropic.messages.create({ model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
    var text = message.content[0].text;
    await supabase.from('payments').update({ plan_text: text, plan_generated: true, plan_generated_at: new Date() }).eq('id', session_id);
    res.json({ text: text });
  } catch(e) {
    console.error('Generate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN ────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_SECRET_KEY) return res.status(401).json({ error: 'Unauthorised' });
  next();
}

app.post('/api/admin/login', function(req, res) {
  if (req.body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  res.json({ token: process.env.ADMIN_SECRET_KEY });
});

app.get('/api/admin/stats', requireAdmin, async function(req, res) {
  try {
    var visitors = await supabase.from('visitors').select('id', { count: 'exact', head: true });
    var payments = await supabase.from('payments').select('id', { count: 'exact', head: true }).eq('status', 'complete');
    var todayStart = new Date(new Date().setHours(0,0,0,0)).toISOString();
    var todayVisitors = await supabase.from('visitors').select('id', { count: 'exact', head: true }).gte('created_at', todayStart);
    var todayPayments = await supabase.from('payments').select('id', { count: 'exact', head: true }).eq('status', 'complete').gte('completed_at', todayStart);
    var revenueData = await supabase.from('payments').select('amount').eq('status', 'complete');
    var total_revenue = (revenueData.data || []).reduce(function(s, p) { return s + Number(p.amount); }, 0);
    res.json({
      total_visitors: visitors.count || 0,
      total_conversions: payments.count || 0,
      total_revenue: total_revenue,
      conversion_rate: visitors.count ? ((payments.count / visitors.count) * 100).toFixed(1) : '0',
      today_visitors: todayVisitors.count || 0,
      today_conversions: todayPayments.count || 0,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/funnel', requireAdmin, async function(req, res) {
  var steps = ['capture', 'quiz_step_0', 'quiz_step_1', 'quiz_step_2', 'quiz_step_3', 'quiz_step_4', 'preview', 'payment_complete'];
  var counts = await Promise.all(steps.map(async function(step) {
    var result = await supabase.from('sessions').select('visitor_id', { count: 'exact', head: true }).eq('step', step);
    return { step: step, count: result.count || 0 };
  }));
  res.json(counts);
});

app.get('/api/admin/visitors', requireAdmin, async function(req, res) {
  var page = parseInt(req.query.page) || 1;
  var limit = 50;
  var offset = (page - 1) * limit;
  var result = await supabase.from('visitors').select('id, name, email, source, last_step, converted, created_at').order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (result.error) return res.status(500).json({ error: result.error.message });
  res.json(result.data);
});

// ── START ────────────────────────────────────────────────────
var PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('HustleAI backend running on port ' + PORT); });

module.exports = app;
