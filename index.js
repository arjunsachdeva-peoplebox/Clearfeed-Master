const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const CLEARFEED_TOKEN = process.env.CLEARFEED_API_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── SUPABASE HELPER ──
async function supabase(path, method = 'GET', body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
    },
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${method} ${path} failed: ${err}`);
  }
  if (method === 'GET') return res.json();
  return null;
}

// ── CLEARFEED HELPER ──
async function clearfeedFetch(path) {
  const res = await fetch(`https://api.clearfeed.app/v1/rest${path}`, {
    headers: { 'Authorization': `Bearer ${CLEARFEED_TOKEN}` },
  });
  if (!res.ok) throw new Error(`ClearFeed ${path} failed: ${res.status}`);
  return res.json();
}

// ── GROQ AI PROCESSING ──
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function groqWithRetry(prompt, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 512,
      }),
    });
    if (res.status === 429) {
      const wait = (i + 1) * 15000; // 15s, 30s, 45s
      console.log(`  Rate limited, waiting ${wait/1000}s...`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`Groq API failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  throw new Error('Groq API failed after retries');
}

async function analyseTicket(ticket, messages) {
  const conversation = messages
    .map(m => `[${m.is_responder ? 'AGENT' : 'CUSTOMER'}]: ${m.text}`)
    .join('\n');

  const prompt = `You are analysing a B2B SaaS support ticket for Peoplebox (an HR performance management platform). 

Ticket title: ${ticket.title}
Collection: ${ticket.collection_name}
Priority: ${ticket.priority}
Status: ${ticket.state}

Conversation:
${conversation || '(no messages)'}

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "summary": "2-sentence summary of the issue and resolution",
  "issue_type": "one of: bug | feature_request | admin_action | knowledge_gap | integration_issue | access_issue",
  "product_areas": ["array of product areas from: Goals | Reviews | OKRs | IDP | Surveys | Org Chart | Integrations | API | Billing | User Management | Notifications | Reports | Other"],
  "features_mentioned": ["specific features or capabilities the customer mentioned or requested"],
  "urgency_score": 1-5,
  "sentiment": "one of: positive | neutral | frustrated | urgent",
  "resolution_quality": "one of: fully_resolved | partially_resolved | unresolved | redirected",
  "key_tags": ["2-5 short descriptive tags for this ticket"]
}`;

  const data = await groqWithRetry(prompt);
  const text = data.choices?.[0]?.message?.content || '{}';
  const tokenCount = data.usage?.total_tokens || 0;

  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return { analysis: JSON.parse(cleaned), tokenCount };
  } catch {
    return { analysis: null, tokenCount };
  }
}

// ── FETCH ALL TICKETS (paginated) ──
async function fetchAllTickets(params = {}) {
  const tickets = [];
  let cursor = null;
  let page = 0;

  do {
    const qs = new URLSearchParams({
      limit: '100',
      include: 'messages',
      ...params,
      ...(cursor ? { next_cursor: cursor } : {}),
    });

    const data = await clearfeedFetch(`/requests?${qs}`);
    const batch = data.requests || [];
    tickets.push(...batch);
    cursor = data.response_metadata?.next_cursor || null;
    page++;
    console.log(`  Page ${page}: fetched ${batch.length} tickets (total: ${tickets.length})`);

    // small delay to respect rate limits
    if (cursor) await new Promise(r => setTimeout(r, 300));
  } while (cursor);

  return tickets;
}

// ── UPSERT TICKET TO SUPABASE ──
async function upsertTicket(t) {
  const cf = t.custom_field_values || {};
  const linkedTickets = t.tickets || [];
  const linearTicket = linkedTickets.find(lt => lt.type === 'linear');

  const row = {
    id: t.id,
    title: t.title,
    state: t.state,
    priority: t.priority,
    author_email: t.author_email || null,
    assignee_id: t.assignee?.id || null,
    collection_id: t.collection?.id || null,
    collection_name: t.collection?.name || null,
    channel_id: t.channel?.id || null,
    channel_name: t.channel?.name || null,
    account_id: cf['6'] ? parseInt(cf['6']) : null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    last_message_time: t.last_message_time,
    frt_minutes: t.sla_metrics?.first_response_time?.value ?? null,
    frt_breached: t.sla_metrics?.first_response_time?.is_breached ?? null,
    resolution_minutes: t.sla_metrics?.resolution_time?.value ?? null,
    first_resolution_minutes: t.sla_metrics?.first_resolution_time?.value ?? null,
    has_linear_ticket: !!linearTicket,
    linear_ticket_key: linearTicket?.key || null,
    slack_url: t.request_thread?.url || null,
    custom_field_1: cf['1']?.toString() || null,
    custom_field_3: cf['3']?.toString() || null,
    custom_field_7: cf['7']?.toString() || null,
    custom_field_9: Array.isArray(cf['9']) ? cf['9'].join(',') : cf['9']?.toString() || null,
    custom_field_10: cf['10']?.toString() || null,
    custom_field_12: cf['12']?.toString() || null,
    custom_field_14: cf['14']?.toString() || null,
    raw_custom_fields: cf,
    synced_at: new Date().toISOString(),
  };

  await supabase('/tickets?on_conflict=id', 'POST', row);
  return row;
}

// ── UPSERT MESSAGES TO SUPABASE ──
async function upsertMessages(ticketId, messages) {
  if (!messages?.length) return 0;

  // delete existing messages for this ticket first
  await supabase(`/messages?ticket_id=eq.${ticketId}`, 'DELETE');

  const rows = messages.map((m, i) => ({
    ticket_id: ticketId,
    message_index: i,
    text: m.text || '',
    author_id: m.author || null,
    is_responder: m.is_responder || false,
    ts: m.ts ? (() => { try { const d = new Date(parseFloat(m.ts) * 1000); return isNaN(d.getTime()) ? null : d.toISOString(); } catch { return null; } })() : null,
  }));

  // insert in batches of 50
  for (let i = 0; i < rows.length; i += 50) {
    await supabase('/messages', 'POST', rows.slice(i, i + 50));
  }
  return rows.length;
}

// ── UPSERT AI ANALYSIS ──
async function upsertAnalysis(ticketId, analysis, tokenCount) {
  if (!analysis) return;

  const row = {
    ticket_id: ticketId,
    summary: analysis.summary || null,
    issue_type: analysis.issue_type || null,
    product_areas: analysis.product_areas || [],
    features_mentioned: analysis.features_mentioned || [],
    urgency_score: analysis.urgency_score || null,
    sentiment: analysis.sentiment || null,
    resolution_quality: analysis.resolution_quality || null,
    key_tags: analysis.key_tags || [],
    raw_ai_output: analysis,
    token_count: tokenCount,
    processed_at: new Date().toISOString(),
  };

  await supabase('/ticket_analysis?on_conflict=ticket_id', 'POST', row);
}

// ── MAIN SYNC FUNCTION ──
async function runSync(options = {}) {
  const {
    daysBack = 180,
    collectionsFilter = null,
    skipAI = false,
    onlyNewTickets = false,
  } = options;

  const after = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  console.log(`\n🔄 Starting sync: last ${daysBack} days (after ${after})`);

  // log sync start
  const logRes = await supabase('/sync_log', 'POST', { status: 'running', started_at: new Date().toISOString() });

  let ticketsSynced = 0;
  let messagesSynced = 0;
  let ticketsAnalysed = 0;
  let totalTokens = 0;

  try {
    const params = { after };
    if (collectionsFilter) params.collection_id = collectionsFilter;

    const tickets = await fetchAllTickets(params);
    console.log(`\n📦 Total tickets to process: ${tickets.length}`);

    for (const ticket of tickets) {
      try {
        const messages = ticket.messages || [];

        // upsert ticket
        await upsertTicket(ticket);
        ticketsSynced++;

        // upsert messages
        const msgCount = await upsertMessages(ticket.id, messages);
        messagesSynced += msgCount;

        // AI analysis (skip if already analysed and onlyNewTickets)
        if (!skipAI) {
          const { analysis, tokenCount } = await analyseTicket(ticket, messages);
          await upsertAnalysis(ticket.id, analysis, tokenCount);
          if (analysis) ticketsAnalysed++;
          totalTokens += tokenCount;
          await sleep(4000); // 4s delay = ~15 tickets/min, safe for Groq 12K TPM
        }

        if (ticketsSynced % 10 === 0) {
          console.log(`  ✅ ${ticketsSynced}/${tickets.length} tickets | ${messagesSynced} messages | ${ticketsAnalysed} analysed | ${totalTokens} tokens`);
        }
      } catch (err) {
        console.error(`  ❌ Ticket ${ticket.id} failed: ${err.message}`);
      }
    }

    // update sync log
    await supabase('/sync_log?id=eq.1&order=id.desc&limit=1', 'PATCH', {
      completed_at: new Date().toISOString(),
      tickets_synced: ticketsSynced,
      messages_synced: messagesSynced,
      tickets_analysed: ticketsAnalysed,
      status: 'completed',
    });

    const summary = { ticketsSynced, messagesSynced, ticketsAnalysed, totalTokens };
    console.log('\n✅ Sync complete:', summary);
    return summary;

  } catch (err) {
    console.error('Sync failed:', err.message);
    throw err;
  }
}

// ── ROUTES ──
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Proxy routes (keep existing ones working)
app.get('/tickets', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const data = await clearfeedFetch(`/requests${qs ? '?' + qs : ''}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/tickets/:id', async (req, res) => {
  try {
    const data = await clearfeedFetch(`/requests/${req.params.id}?include=messages`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger full sync
app.post('/sync', async (req, res) => {
  const { days = 180, skipAI = false } = req.body || {};
  res.json({ message: 'Sync started in background', days });
  runSync({ daysBack: parseInt(days), skipAI }).catch(console.error);
});

// Analyse-only: process tickets that don't have AI analysis yet
app.post('/analyse', async (req, res) => {
  res.json({ message: 'AI analysis started in background' });

  (async () => {
    console.log('\n🤖 Starting AI analysis of unanalysed tickets...');
    let processed = 0;
    let offset = 0;
    const batchSize = 20;

    while (true) {
      // fetch unanalysed tickets with their messages
      const tickets = await supabase(
        `/tickets?select=id,title,state,priority,collection_name&id=not.in.(select ticket_id from ticket_analysis)&order=created_at.asc&limit=${batchSize}&offset=${offset}`,
        'GET'
      );
      if (!tickets?.length) break;

      for (const ticket of tickets) {
        try {
          const messages = await supabase(`/messages?ticket_id=eq.${ticket.id}&order=message_index.asc`, 'GET');
          const { analysis, tokenCount } = await analyseTicket(ticket, messages || []);
          await upsertAnalysis(ticket.id, analysis, tokenCount);
          if (analysis) processed++;
          if (processed % 10 === 0) console.log(`  🤖 ${processed} tickets analysed`);
          await sleep(4000);
        } catch (err) {
          console.error(`  ❌ Analysis failed for ${ticket.id}: ${err.message}`);
        }
      }
      offset += batchSize;
    }
    console.log(`\n✅ AI analysis complete. ${processed} tickets analysed.`);
  })().catch(console.error);
});

// Sync status
app.get('/sync/status', async (req, res) => {
  try {
    const rows = await supabase('/sync_log?order=id.desc&limit=5', 'GET');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`ClearFeed sync service running on port ${PORT}`));
