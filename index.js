const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const CLEARFEED_TOKEN = process.env.CLEARFEED_API_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

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

// ── AI PROCESSING (Gemini-primary, Groq fallback) ──
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Signals a rate/quota limit that won't recover within this run (e.g. Gemini's daily cap),
// so batch jobs can pause cleanly and resume later instead of churning or falling back.
class RateLimitError extends Error {
  constructor(message) { super(message); this.name = 'RateLimitError'; this.rateLimited = true; }
}

// Both providers normalise to { text, tokenCount }.
async function groqComplete(prompt, { maxTokens = 400, json = false } = {}, retries = 6) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant', // higher rate limits than 70b on free tier
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (res.status === 429) {
      const body = await res.text();
      // Groq tells us exactly how long to wait, e.g. "try again in 5.415s"
      let wait = (i + 1) * 8000;
      const m = body.match(/try again in ([\d.]+)(ms|s)/);
      if (m) wait = parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1) + 1500;
      console.log(`  Groq rate limited, waiting ${Math.round(wait)}ms...`);
      await sleep(Math.min(wait, 65000));
      continue;
    }
    if (!res.ok) throw new Error(`Groq API failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return { text: data.choices?.[0]?.message?.content || '', tokenCount: data.usage?.total_tokens || 0 };
  }
  // Sustained 429s (e.g. Groq daily free-tier cap) — signal a clean pause so the batch
  // stops and resumes after reset, instead of junking tickets with empty placeholders.
  throw new RateLimitError('Groq rate-limited after retries');
}

async function geminiComplete(prompt, { maxTokens = 400, json = false } = {}, retries = 6) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: maxTokens,
          // Disable "thinking" — these are extraction tasks, and thinking burns output
          // tokens (can truncate the JSON) and free-tier quota for no quality gain.
          thinkingConfig: { thinkingBudget: 0 },
          ...(json ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    });
    if (res.status === 429 || res.status === 503) {
      const body = await res.text();
      const m = body.match(/"retryDelay":\s*"([\d.]+)s"/);
      const retryDelay = m ? parseFloat(m[1]) : null;
      // Per-minute throttling (RPM) and transient 503s come with a SHORT retry hint — just
      // wait it out and retry. Only treat it as the DAILY cap (and pause the batch) when the
      // per-day quota is named AND there's no short recovery (no/large retryDelay).
      if (res.status === 429 && (retryDelay === null || retryDelay > 120) && /per\s*day|perday/i.test(body)) {
        throw new RateLimitError('Gemini daily quota (requests/day) exhausted');
      }
      const wait = retryDelay != null ? retryDelay * 1000 + 1500 : (i + 1) * 8000;
      console.log(`  Gemini ${res.status}, waiting ${Math.round(wait)}ms...`);
      await sleep(Math.min(wait, 65000));
      continue;
    }
    if (!res.ok) throw new Error(`Gemini API failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    return { text, tokenCount: data.usageMetadata?.totalTokenCount || 0 };
  }
  throw new RateLimitError('Gemini rate-limited after retries');
}

// ── PROVIDER REGISTRY ──
// Each provider hides its own rate-limit/pacing presets (delay, context size). To add a
// 3rd model later: add an entry here plus its *Complete() fn — the dashboard dropdown picks
// it up automatically from GET /provider. `delay` is the spacing between calls (its rate
// limit), `bigContext` decides whether full conversations are sent.
const PROVIDERS = {
  groq: {
    id: 'groq', label: 'Groq · Llama 3.1 8B (fast, no daily cap)',
    delay: 4000, bigContext: false, model: 'llama-3.1-8b-instant',
    complete: groqComplete, available: () => !!GROQ_API_KEY,
  },
  gemini: {
    id: 'gemini', label: 'Gemini 2.5 Flash (full context, ~4/min)',
    delay: 15000, bigContext: true, model: GEMINI_MODEL,
    complete: geminiComplete, available: () => !!GEMINI_API_KEY,
  },
};

function defaultProvider() {
  const envP = process.env.AI_PROVIDER;
  if (envP && PROVIDERS[envP] && PROVIDERS[envP].available()) return envP;
  if (PROVIDERS.groq.available()) return 'groq';
  return Object.keys(PROVIDERS).find(k => PROVIDERS[k].available()) || 'groq';
}

// Runtime-selected provider (changeable via POST /provider). Resets to the env default on
// restart. `aiDelay()` returns the active provider's preset pacing.
let activeProvider = defaultProvider();
const aiDelay = () => PROVIDERS[activeProvider]?.delay ?? 4000;

// Unified entry point — routes to the active provider. For non-batch callers it falls back
// to Groq if the active provider errors; batch callers pass pauseOnRateLimit so a rate/quota
// limit propagates instead (letting the job pause cleanly and resume later).
async function aiComplete(prompt, opts = {}) {
  const { pauseOnRateLimit = false, ...gen } = opts;
  const provider = PROVIDERS[activeProvider] || PROVIDERS.groq;
  try {
    return await provider.complete(prompt, gen);
  } catch (e) {
    if (e.rateLimited && pauseOnRateLimit) throw e;
    if (activeProvider !== 'groq' && GROQ_API_KEY) {
      console.warn(`  ${activeProvider} failed (${e.message}); falling back to Groq.`);
      return await groqComplete(prompt, gen);
    }
    throw e;
  }
}

async function analyseTicket(ticket, messages, opts = {}) {
  // Big-context providers (Gemini) get the full thread; tight-TPM ones (Groq) need truncation.
  const big = PROVIDERS[activeProvider]?.bigContext;
  const perMsg = big ? 4000 : 600;
  const maxConv = big ? 30000 : 3000;
  let conversation = messages
    .map(m => `[${m.is_responder ? 'AGENT' : 'CUSTOMER'}]: ${(m.text || '').slice(0, perMsg)}`)
    .join('\n');
  if (conversation.length > maxConv) conversation = conversation.slice(0, maxConv) + '\n...(truncated)';

  const prompt = `You are analysing a B2B SaaS support ticket for Peoplebox (an HR performance management platform). 

Ticket title: ${ticket.title}
Collection: ${ticket.collection_name}
Priority: ${ticket.priority}
Status: ${ticket.state}

Conversation:
${conversation || '(no messages)'}

The PRIMARY goal of this analysis is to REDUCE the number of future tickets. So beyond
describing the ticket, judge what would have prevented it from ever being created.

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "summary": "2-sentence summary of the issue and resolution",
  "issue_type": "one of: bug | feature_request | admin_action | knowledge_gap | integration_issue | access_issue",
  "product_areas": ["array of product areas from: Goals | Reviews | OKRs | IDP | Surveys | Org Chart | Integrations | API | Billing | User Management | Notifications | Reports | Other"],
  "features_mentioned": ["specific features or capabilities the customer mentioned or requested"],
  "urgency_score": 1-5,
  "sentiment": "one of: positive | neutral | frustrated | urgent",
  "resolution_quality": "one of: fully_resolved | partially_resolved | unresolved | redirected",
  "key_tags": ["2-5 short descriptive tags for this ticket"],
  "root_cause_category": "the underlying reason this ticket exists, one of: onboarding_setup | feature_discovery | workflow_confusion | bug_defect | access_provisioning | billing | knowledge_gap | integration_config | other",
  "eliminable": true or false (true if a product/UX/onboarding/docs change could have PREVENTED this ticket; false if it inherently needs a human, e.g. a one-off account request),
  "elimination_lever": "the single best way to prevent it, one of: product_fix | ux_improvement | onboarding | self_service_kb | automation | engineering_fix | none",
  "fix_owner": "who should own the prevention, one of: product | engineering | design | docs_support | ops | none",
  "prevention_note": "one concrete sentence on what change would stop this ticket from recurring"
}`;

  const { text, tokenCount } = await aiComplete(prompt, { maxTokens: 500, json: true, ...opts });

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
    root_cause_category: analysis.root_cause_category || null,
    eliminable: typeof analysis.eliminable === 'boolean' ? analysis.eliminable : null,
    elimination_lever: analysis.elimination_lever || null,
    fix_owner: analysis.fix_owner || null,
    prevention_note: analysis.prevention_note || null,
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
      if (stopRequested) { console.log('\n🛑 Sync stopped by request.'); break; }
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
          await sleep(aiDelay());
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
app.get('/health', (req, res) => res.json({
  status: 'ok',
  ai_provider: activeProvider,
  model: PROVIDERS[activeProvider]?.model,
}));

// ── AI MODEL SELECTOR ──
// Lists selectable models (rate-limit presets are hidden — each model just works) and the
// currently active one. POST switches it at runtime. Resets to the env default on restart.
app.get('/provider', (req, res) => res.json({
  active: activeProvider,
  providers: Object.values(PROVIDERS).map(p => ({ id: p.id, label: p.label, available: p.available() })),
}));
app.post('/provider', (req, res) => {
  const { provider } = req.body || {};
  if (!provider || !PROVIDERS[provider]) return res.status(400).json({ error: 'unknown provider' });
  if (!PROVIDERS[provider].available()) return res.status(400).json({ error: `${provider} is not configured (missing API key on the server)` });
  activeProvider = provider;
  console.log(`AI provider switched to ${activeProvider}`);
  res.json({ active: activeProvider, model: PROVIDERS[activeProvider].model });
});

// ── STOP CONTROL ──
// Cooperative cancellation: background loops (sync / analyse / enrich / cluster) check this
// flag between items and halt gracefully. Each run clears it at start.
let stopRequested = false;
app.post('/stop', (req, res) => {
  stopRequested = true;
  res.json({ message: 'Stop requested — background jobs will halt within a few seconds.' });
});

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
  stopRequested = false;
  res.json({ message: 'Sync started in background', days });
  runSync({ daysBack: parseInt(days), skipAI }).catch(console.error);
});

// Track whether an analysis run is already active (avoid duplicate parallel runs)
let analyseRunning = false;

// Analyse-only: process tickets that don't have AI analysis yet.
// Uses the `unanalysed_tickets` view, so already-analysed tickets are
// automatically skipped — no ticket is ever re-analysed (saves tokens).
app.post('/analyse', async (req, res) => {
  if (analyseRunning) {
    return res.json({ message: 'Analysis already running', alreadyRunning: true });
  }
  analyseRunning = true;
  stopRequested = false;
  res.json({ message: 'AI analysis started in background' });

  (async () => {
    console.log('\n🤖 Starting AI analysis of unanalysed tickets...');
    let processed = 0;
    let paused = false;
    let stopped = false;

    try {
      while (true) {
        if (stopRequested) { stopped = true; break; }
        // The view only returns tickets WITHOUT analysis. As we analyse
        // them they drop out of the view, so we always pull the next batch.
        const tickets = await supabase(
          `/unanalysed_tickets?select=id,title,state,priority,collection_name&order=created_at.asc&limit=20`,
          'GET'
        );
        if (!tickets?.length) break;

        for (const ticket of tickets) {
          if (stopRequested) { stopped = true; break; }
          try {
            const messages = await supabase(`/messages?ticket_id=eq.${ticket.id}&order=message_index.asc`, 'GET');
            // pauseOnRateLimit: if Gemini's daily quota is hit, stop cleanly (no Groq fallback,
            // no placeholder) so re-running later resumes on Gemini for the remaining tickets.
            const { analysis, tokenCount } = await analyseTicket(ticket, messages || [], { pauseOnRateLimit: true });
            await upsertAnalysis(ticket.id, analysis, tokenCount);
            if (analysis) processed++;
            if (processed % 10 === 0) console.log(`  🤖 ${processed} tickets analysed`);
            await sleep(aiDelay()); // pace AI calls for the active provider
          } catch (err) {
            // Rate/quota limit (e.g. Groq daily cap): PAUSE cleanly and resume after reset —
            // do NOT junk the ticket, so it gets a real analysis later.
            if (err.rateLimited) { paused = true; break; }
            // Any other persistent error (e.g. a 400 on a malformed ticket) would otherwise
            // loop forever, so write a minimal placeholder to take it out of the queue.
            console.error(`  ❌ Analysis failed for ${ticket.id}: ${err.message}`);
            await upsertAnalysis(ticket.id, { issue_type: 'admin_action', summary: 'Auto-skipped (AI error)', product_areas: [], features_mentioned: [], key_tags: [] }, 0);
          }
        }
        if (paused || stopped) break;
      }
      if (stopped) {
        console.log(`\n🛑 Analysis stopped by request after ${processed} tickets this run. Click "Run Analysis" to resume the remaining ones.`);
      } else if (paused) {
        console.log(`\n⏸ Analysis paused after ${processed} tickets this run — daily quota reached. Click "Run Analysis" again after it resets to continue.`);
      } else {
        console.log(`\n✅ AI analysis complete. ${processed} tickets analysed this run.`);
      }
    } catch (err) {
      console.error('Analysis run failed:', err.message);
    } finally {
      analyseRunning = false;
    }
  })().catch(e => { console.error(e); analyseRunning = false; });
});

// Ask a free-form question about the analysed data (uses Groq).
// Pulls a compact representation of analysed tickets (optionally filtered)
// and sends only that to Groq — keeps token usage low, no raw messages.
app.post('/ask', async (req, res) => {
  try {
    const { question, collection = null, days = null, type = null, limit = 200 } = req.body || {};
    if (!question) return res.status(400).json({ error: 'question is required' });

    // Build filter for the joined query
    let q = `/tickets?select=id,title,collection_name,state,priority,created_at,ticket_analysis!inner(issue_type,product_areas,features_mentioned,urgency_score,summary,sentiment)`;
    if (collection && collection !== 'all') q += `&collection_name=eq.${encodeURIComponent(collection)}`;
    if (days && days !== 'all') {
      const since = new Date(Date.now() - parseInt(days) * 86400000).toISOString();
      q += `&created_at=gte.${since}`;
    }
    if (type && type !== 'all') q += `&ticket_analysis.issue_type=eq.${type}`;
    // Cap at 120 tickets so a single Groq request stays under the free-tier token-per-minute limit
    q += `&order=created_at.desc&limit=${Math.min(parseInt(limit) || 120, 120)}`;

    const rows = await supabase(q, 'GET');
    const tickets = (rows || []).map(t => ({
      id: t.id,
      title: (t.title || '').slice(0, 100),
      collection: t.collection_name,
      state: t.state,
      type: t.ticket_analysis?.issue_type,
      areas: t.ticket_analysis?.product_areas,
      features: t.ticket_analysis?.features_mentioned,
      urgency: t.ticket_analysis?.urgency_score,
      summary: t.ticket_analysis?.summary,
    }));

    if (!tickets.length) return res.json({ answer: 'No analysed tickets match the current filters. Run analysis first or widen the filters.', count: 0 });

    const context = tickets.map(t =>
      `CF-${t.id} [${t.type}|${t.collection}|${t.state}|urg${t.urgency}] ${(t.title||'').slice(0,70)} :: ${(t.summary||'').slice(0,140)} :: areas=${(t.areas||[]).join(',')} feats=${(t.features||[]).slice(0,4).join(',')}`
    ).join('\n');

    const prompt = `You are a support-data analyst for Peoplebox (HR performance SaaS). Answer the user's question using ONLY the ticket data below. Be specific, cite ticket IDs (CF-xxxx) where relevant, and give counts/patterns. If asked for a list, return a clean list. Keep it concise.

QUESTION: ${question}

TICKET DATA (${tickets.length} analysed tickets):
${context}`;

    const { text: answer, tokenCount } = await aiComplete(prompt, { maxTokens: 800, json: false });
    res.json({ answer: answer || 'No answer generated.', count: tickets.length, tokensUsed: tokenCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ROOT-CAUSE BACKFILL ──
// Cheaply add root_cause_category / eliminable / fix_owner etc. to tickets that were
// already analysed BEFORE these fields existed. Uses only title + summary + issue_type
// (no raw conversation) to stay well under Groq's free-tier token limit. Idempotent:
// only touches rows where root_cause_category IS NULL, so re-running resumes safely.
let enrichRunning = false;
app.post('/enrich-rca', async (req, res) => {
  if (enrichRunning) return res.json({ message: 'Enrichment already running', alreadyRunning: true });
  enrichRunning = true;
  stopRequested = false;
  res.json({ message: 'Root-cause backfill started in background' });

  (async () => {
    console.log('\n🧩 Backfilling root-cause fields for already-analysed tickets...');
    let processed = 0;
    let stopped = false;
    try {
      while (true) {
        if (stopRequested) { stopped = true; break; }
        const rows = await supabase(
          `/tickets?select=id,title,collection_name,ticket_analysis!inner(summary,issue_type,product_areas,root_cause_category)&ticket_analysis.root_cause_category=is.null&limit=25`,
          'GET'
        );
        if (!rows?.length) break;

        for (const t of rows) {
          if (stopRequested) { stopped = true; break; }
          const a = t.ticket_analysis || {};
          const prompt = `You are reducing future support tickets for Peoplebox (HR performance SaaS). For the ticket below, decide what would have PREVENTED it.
Title: ${(t.title || '').slice(0, 160)}
Issue type: ${a.issue_type || 'unknown'}
Product areas: ${(a.product_areas || []).join(', ') || 'unknown'}
Summary: ${(a.summary || '').slice(0, 300)}

Respond with ONLY valid JSON:
{"root_cause_category":"onboarding_setup|feature_discovery|workflow_confusion|bug_defect|access_provisioning|billing|knowledge_gap|integration_config|other","eliminable":true or false,"elimination_lever":"product_fix|ux_improvement|onboarding|self_service_kb|automation|engineering_fix|none","fix_owner":"product|engineering|design|docs_support|ops|none","prevention_note":"one concrete sentence on what change would stop this ticket recurring"}`;
          try {
            const { text } = await aiComplete(prompt, { maxTokens: 300, json: true });
            const cleaned = (text || '{}').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            let rca;
            try { rca = JSON.parse(cleaned); } catch { rca = { root_cause_category: 'other' }; }
            await supabase(`/ticket_analysis?ticket_id=eq.${t.id}`, 'PATCH', {
              root_cause_category: rca.root_cause_category || 'other',
              eliminable: typeof rca.eliminable === 'boolean' ? rca.eliminable : null,
              elimination_lever: rca.elimination_lever || null,
              fix_owner: rca.fix_owner || null,
              prevention_note: rca.prevention_note || null,
            });
            processed++;
            if (processed % 10 === 0) console.log(`  🧩 ${processed} tickets enriched`);
            await sleep(aiDelay());
          } catch (err) {
            console.error(`  ❌ Enrich failed for ${t.id}: ${err.message}`);
            // Mark as 'other' so it leaves the IS NULL set and we don't loop forever.
            await supabase(`/ticket_analysis?ticket_id=eq.${t.id}`, 'PATCH', { root_cause_category: 'other' });
          }
        }
        if (stopped) break;
      }
      if (stopped) console.log(`\n🛑 Root-cause backfill stopped by request after ${processed} tickets.`);
      else console.log(`\n✅ Root-cause backfill complete. ${processed} tickets enriched this run.`);
    } catch (err) {
      console.error('Enrichment run failed:', err.message);
    } finally {
      enrichRunning = false;
    }
  })().catch(e => { console.error(e); enrichRunning = false; });
});

// ── SEMANTIC CLUSTERING (two-pass, LLM-based) ──
// Pass A: build a canonical cluster taxonomy from normalized issue statements.
// Pass B: assign every analysed ticket to one of those clusters.
// LLM-based (not Python BERTopic/HDBSCAN) because the Groq free tier has no embeddings
// endpoint, and LLM semantic normalization is the top-performing approach for short,
// noisy ticket text (FLAIRS-39, 2026). Stores results in ticket_clusters + ticket_analysis.cluster_id.
let clusterRunning = false;
app.post('/cluster', async (req, res) => {
  if (clusterRunning) return res.json({ message: 'Clustering already running', alreadyRunning: true });
  clusterRunning = true;
  stopRequested = false;
  res.json({ message: 'Clustering started in background' });

  (async () => {
    console.log('\n🧭 Clustering: building taxonomy...');
    try {
      // ── PASS A: build taxonomy from a sample of analysed tickets ──
      const sample = await supabase(
        `/tickets?select=id,title,ticket_analysis!inner(summary,issue_type,product_areas,root_cause_category)&order=created_at.desc&limit=300`,
        'GET'
      );
      if (!sample?.length) { console.log('  No analysed tickets to cluster.'); clusterRunning = false; return; }

      const sigLines = sample.map(t => {
        const a = t.ticket_analysis || {};
        return `- ${(a.summary || t.title || '').slice(0, 140)} [${a.issue_type || ''}|${(a.product_areas || []).join('/')}|${a.root_cause_category || ''}]`;
      }).join('\n');

      const taxonomyPrompt = `You are grouping Peoplebox (HR performance SaaS) support tickets into recurring ISSUE CLUSTERS so the team can reduce ticket volume. Below are normalized issue statements. Produce 12-20 coherent, non-overlapping clusters that together cover the common patterns. Merge near-duplicates. Each cluster must be specific enough to act on.

ISSUE STATEMENTS:
${sigLines}

Respond with ONLY a valid JSON array (no markdown):
[{"label":"short cluster name (max 6 words)","root_cause_category":"onboarding_setup|feature_discovery|workflow_confusion|bug_defect|access_provisioning|billing|knowledge_gap|integration_config|other","description":"one sentence on what tickets in this cluster are about","suggested_fix":"the single change that would most reduce these tickets","fix_owner":"product|engineering|design|docs_support|ops"}]`;

      // json mode off: output is a JSON *array*, but Groq's json_object mode requires an object.
      const { text: taxRaw } = await aiComplete(taxonomyPrompt, { maxTokens: 1800, json: false });
      const taxText = (taxRaw || '[]').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      let clusters;
      try { clusters = JSON.parse(taxText); } catch { console.error('  Failed to parse taxonomy JSON'); clusterRunning = false; return; }
      if (!Array.isArray(clusters) || !clusters.length) { console.error('  Empty taxonomy'); clusterRunning = false; return; }
      clusters = clusters.slice(0, 25);

      // Replace the clusters table and reset assignments
      await supabase('/ticket_analysis?cluster_id=not.is.null', 'PATCH', { cluster_id: null });
      await supabase('/ticket_clusters?id=gte.0', 'DELETE');
      const clusterRows = clusters.map((c, i) => ({
        id: i + 1,
        label: (c.label || `Cluster ${i + 1}`).slice(0, 120),
        root_cause_category: c.root_cause_category || 'other',
        description: (c.description || '').slice(0, 400),
        suggested_fix: (c.suggested_fix || '').slice(0, 400),
        fix_owner: c.fix_owner || 'product',
        updated_at: new Date().toISOString(),
      }));
      await supabase('/ticket_clusters', 'POST', clusterRows);
      console.log(`  ✅ Built ${clusterRows.length} clusters. Assigning tickets...`);

      const clusterList = clusterRows.map(c => `${c.id}: ${c.label}`).join('\n');

      // ── PASS B: assign every analysed ticket without a cluster_id ──
      let assigned = 0;
      while (true) {
        if (stopRequested) { console.log('\n🛑 Clustering stopped by request during assignment.'); break; }
        const batch = await supabase(
          `/tickets?select=id,title,ticket_analysis!inner(summary,issue_type,cluster_id)&ticket_analysis.cluster_id=is.null&order=created_at.desc&limit=15`,
          'GET'
        );
        if (!batch?.length) break;

        const items = batch.map(t => {
          const a = t.ticket_analysis || {};
          return `CF-${t.id}: ${(a.summary || t.title || '').slice(0, 140)}`;
        }).join('\n');

        const assignPrompt = `Assign each ticket to the SINGLE best-matching cluster id from the list. If none fit, use 0.

CLUSTERS:
${clusterList}

TICKETS:
${items}

Respond with ONLY a valid JSON object mapping ticket id (without the CF- prefix) to cluster id, e.g. {"123":4,"456":0}`;

        let map = {};
        try {
          const { text: aText } = await aiComplete(assignPrompt, { maxTokens: 600, json: true, pauseOnRateLimit: true });
          map = JSON.parse((aText || '{}').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
        } catch (err) {
          if (err.rateLimited) { console.log('  ⏸ Clustering paused — Gemini daily quota reached. Run "Rebuild Clusters" again after it resets.'); break; }
          console.error(`  ❌ Assign batch failed: ${err.message}`);
        }

        for (const t of batch) {
          const cid = parseInt(map[t.id] ?? map[String(t.id)] ?? 0) || 0;
          // Use 0 (no fit) → store as null but mark processed via cluster_id = 0 sentinel.
          await supabase(`/ticket_analysis?ticket_id=eq.${t.id}`, 'PATCH', { cluster_id: cid > 0 ? cid : 0 });
          assigned++;
        }
        if (assigned % 30 === 0) console.log(`  🧭 ${assigned} tickets assigned`);
        await sleep(aiDelay());
      }
      console.log(`\n✅ Clustering complete. ${clusterRows.length} clusters, ${assigned} tickets assigned.`);
    } catch (err) {
      console.error('Clustering run failed:', err.message);
    } finally {
      clusterRunning = false;
    }
  })().catch(e => { console.error(e); clusterRunning = false; });
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

app.listen(PORT, () => console.log(`ClearFeed sync service running on port ${PORT} · AI provider: ${activeProvider} (${PROVIDERS[activeProvider]?.model})`));
