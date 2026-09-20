#!/usr/bin/env node
'use strict';
/**
 * Nyhetsagent – GitHub Actions-versjon (synkronisert med _20)
 *
 * Påkrevde GitHub Secrets:
 *   GMAIL_TOKEN         – innhold av Dokumenter\Nyhetsagent\gmail_token.json
 *   GMAIL_CREDENTIALS   – innhold av credentials.json (fra app-mappen)
 *   EMAIL_TO            – din e-postadresse
 *
 * Valgfrie secrets:
 *   ANTHROPIC_KEY
 *   SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET
 *   ENABLED_FEEDS  – kommaseparert liste over feeder (standard: alle nyheter)
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

const MODE       = process.argv[2] || 'alerts';
const EMAIL_TO   = process.env.EMAIL_TO                || '';
const ANTHROPIC  = process.env.ANTHROPIC_KEY           || '';
const SPOTIFY_ID = process.env.SPOTIFY_CLIENT_ID       || '';
const SPOTIFY_SC = process.env.SPOTIFY_CLIENT_SECRET   || '';

// ── Credentials & token ───────────────────────────────────────────────────────

function loadCreds() {
  const raw = process.env.GMAIL_CREDENTIALS
    ? JSON.parse(process.env.GMAIL_CREDENTIALS)
    : JSON.parse(fs.readFileSync('credentials.json', 'utf-8'));
  const c = raw.installed || raw.web;
  if (!c) throw new Error('Ugyldig credentials.json');
  return c;
}

let _token = null;
function loadToken() {
  if (_token) return _token;
  _token = process.env.GMAIL_TOKEN
    ? JSON.parse(process.env.GMAIL_TOKEN)
    : JSON.parse(fs.readFileSync('gmail_token.json', 'utf-8'));
  return _token;
}

// Bruk alltid /tmp slik at workflow-filen finner filene på samme sted
const SENT_FILE = '/tmp/nyhetsagent_sent.json';
const LAST_FILE = '/tmp/nyhetsagent_last_email.json';

function loadSent() {
  try {
    if (fs.existsSync(SENT_FILE)) {
      const d = JSON.parse(fs.readFileSync(SENT_FILE, 'utf-8'));
      const cut = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return Object.fromEntries(Object.entries(d).filter(([, t]) => t > cut));
    }
  } catch (e) {}
  return {};
}
function saveSent(d) { fs.writeFileSync(SENT_FILE, JSON.stringify(d, null, 2)); }

// ── Feeds ─────────────────────────────────────────────────────────────────────

const FEEDS = [
  { name:'NRK',             url:'https://www.nrk.no/nyheter/siste.rss',                                           cat:'nyheter' },
  { name:'Aftenposten',     url:'https://www.aftenposten.no/rss',                                                  cat:'nyheter' },
  { name:'VG',              url:'https://www.vg.no/rss/feed/',                                                     cat:'nyheter' },
  { name:'TV2',             url:'https://www.tv2.no/rss/nyheter',                                                  cat:'nyheter' },
  { name:'E24',             url:'https://e24.no/rss',                                                              cat:'nyheter' },
  { name:'Nettavisen',      url:'https://www.nettavisen.no/service/rss',                                           cat:'nyheter' },
  { name:'TLDR Tech',       url:'https://tldr.tech/api/rss/tech',                                                  cat:'nyheter' },
  { name:'TLDR AI',         url:'https://tldr.tech/api/rss/ai',                                                    cat:'nyheter' },
  { name:'Wired',           url:'https://www.wired.com/feed/rss',                                                  cat:'nyheter' },
  { name:'Ars Technica',    url:'https://feeds.arstechnica.com/arstechnica/index',                                 cat:'nyheter' },
  { name:'TechCrunch',      url:'https://techcrunch.com/feed/',                                                    cat:'nyheter' },
  { name:'MIT Tech Review', url:'https://www.technologyreview.com/feed/',                                          cat:'nyheter' },
  { name:'BBC News',        url:'https://feeds.bbci.co.uk/news/rss.xml',                                          cat:'nyheter' },
  { name:'BBC Europa',      url:'https://feeds.bbci.co.uk/news/world/europe/rss.xml',                             cat:'nyheter' },
  { name:'BBC USA',         url:'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml',                      cat:'nyheter' },
  { name:'Euronews',        url:'https://www.euronews.com/rss?format=mrss&level=theme&name=news',                 cat:'nyheter' },
  { name:'AP News',         url:'https://news.google.com/rss/search?q=site:apnews.com&hl=en-US&gl=US&ceid=US:en',cat:'nyheter' },
  { name:'Deadline',        url:'https://deadline.com/feed',                                                       cat:'nyheter' },
  { name:'Hollywood Reporter', url:'https://www.hollywoodreporter.com/feed/',                                     cat:'nyheter' },
  { name:'Variety',         url:'https://variety.com/feed/',                                                       cat:'nyheter' },
  { name:'Roger Ebert',     url:'https://www.rogerebert.com/feed',                                                 cat:'film'    },
  { name:'Slash Film',      url:'https://www.slashfilm.com/feed/',                                                 cat:'film'    },
  { name:'Film Inquiry',    url:'https://filminquiry.com/feed/',                                                   cat:'film'    },
  { name:'Movieweb',        url:'https://movieweb.com/feed/',                                                      cat:'film'    },
  { name:'Pitchfork',       url:'https://pitchfork.com/feed/rss',                                                  cat:'musikk'  },
  { name:'Consequence',     url:'https://consequenceofsound.net/feed/',                                            cat:'musikk'  },
  { name:'Metal Injection', url:'https://metalinjection.net/feed',                                                 cat:'musikk'  },
  { name:'PopMatters',      url:'https://www.popmatters.com/feed/',                                                cat:'musikk'  },
];

const ROUTES = [
  { name:'Politikk',      keywords:['regjeringen','stortinget','statsminister','valg','minister','høyre','frp','arbeiderpartiet','government','election','president','congress','trump'] },
  { name:'Økonomi',       keywords:['økonomi','rente','inflasjon','børs','oljepris','budsjett','skatt','aksjer','economy','inflation','stock','market','fed','tariff'] },
  { name:'Krim',          keywords:['politi','arrestert','drap','ran','siktet','tiltalt','skadet','savnet','police','arrested','murder','shooting','killed','suspect','crime'] },
  { name:'AI',            keywords:['artificial intelligence','machine learning','chatgpt','openai','anthropic','gemini','llm','claude','gpt','nvidia','ai model','generative'] },
  { name:'Underholdning', keywords:['celebrity','hollywood','taylor swift','netflix','movie','film','award','grammy','oscar','trailer','streaming','singer','actor'] },
];

const ENABLED_FEEDS = process.env.ENABLED_FEEDS
  ? process.env.ENABLED_FEEDS.split(',').map(s => s.trim())
  : FEEDS.filter(f => f.cat === 'nyheter').map(f => f.name);

// ── Filtre ────────────────────────────────────────────────────────────────────

const REALITY_KEYWORDS = [
  'bachelor','bachelorette','love island','paradise hotel','robinson','temptation island',
  'big brother','the circle','survivor','amazing race','married at first sight',
  'real housewives','rhony','rhobh','vanderpump','jersey shore','keeping up with',
  'kardashian','jenner','duggar','honey boo','toddlers and tiaras','dance moms',
  '90 day fiance','teen mom','16 and pregnant','my 600-lb life',
  'kim kardashian','khloe kardashian','kourtney kardashian','kylie jenner','kendall jenner',
  'kris jenner','pete davidson','scott disick','travis barker','tristan thompson',
  'paris hilton','nicole richie','lindsay lohan','tori spelling','denise richards',
  'lisa rinna','erika jayne','bethenny frankel','luann de lesseps','brandi glanville',
  'red carpet look','what she wore','back together','baby bump','expecting a baby',
  'pregnancy reveal','engaged to','wedding plans','splits from','dating again',
  'spotted with','stepping out with','pda with','their relationship','they broke up',
];

const SPORT_KEYWORDS = [
  'premier league','champions league','la liga','serie a','bundesliga','ligue 1',
  'nba','nfl','nhl','mlb','formula 1','formula one','f1 grand prix',
  'tour de france','wimbledon','us open','australian open','french open',
  'super bowl','world series','stanley cup','nba finals',
  'transfer news','transfer window','signing for','signs for','loan deal',
  'match report','full time','half time','final score','goal scored',
  'yellow card','red card','penalty shootout','extra time',
  'tennis results','golf results','cycling results','athletics results',
  'boxing results','ufc results','mma results',
  'eliteserien','tippeligaen','rosenborg','brann','vålerenga','molde',
  'lillestrøm','fredrikstad','stabæk','sarpsborg','ham-kam','odd',
  'arsenal','chelsea','manchester united','manchester city','liverpool','tottenham',
  'real madrid','barcelona','atletico madrid','juventus','ac milan','inter milan',
  'bayern münchen','borussia dortmund','psg','paris saint-germain',
];

const NORWAY_NATIONAL_TEAM = [
  'norge','norway','norges','det norske landslaget',
  'erling haaland','martin ødegaard','alexander sørloth',
  'norge -','norge v ','norge mot ','landslaget i fotball',
  'wc qualifying','em-kvalifisering','vm-kvalifisering','nations league',
];

const INFLUENCER_KEYWORDS = [
  'influencer','influenser','youtuber','tiktoker','content creator','vlogger',
  'instagram star','instagram model','social media star','twitch streamer',
  'subscriber','followers','went viral','gikk viralt','viral video',
  'sponsored post','brand deal','collab with','collaboration with',
  'mr beast','mrbeast','ninja','pewdiepie','markiplier','jacksepticeye',
  'jake paul','logan paul','ksi','addison rae','charli damelio','dixie damelio',
  'emma chamberlain','david dobrik','james charles','jeffree star',
];

// Norske kilder vises først i e-post
const NORWEGIAN_SOURCES = ['VG', 'NRK', 'Aftenposten', 'TV2', 'Nettavisen'];

// Promo-fraser som filtreres bort
const PROMO_KEYWORDS = [
  'promo code','promo kode','discount code','coupon code','use code',
  'rabattkode','bruk kode','klikk her for','sponsored','advertisement',
  'affiliate','paid partnership','annons',
];

// Fotball-resultater fra disse ligaene beholdes
const ALLOWED_FOOTBALL = [
  'eliteserien','premier league',
];

function shouldFilter(item) {
  const text = ((item.title||'') + ' ' + (item.description||'')).toLowerCase();
  if (REALITY_KEYWORDS.some(kw => text.includes(kw))) return true;
  if (INFLUENCER_KEYWORDS.some(kw => text.includes(kw))) return true;
  if (PROMO_KEYWORDS.some(kw => text.includes(kw))) return true;
  if (SPORT_KEYWORDS.some(kw => text.includes(kw))) {
    // Behold norske landskamper
    if (NORWAY_NATIONAL_TEAM.some(kw => text.includes(kw))) return false;
    // Behold Eliteserien og Premier League resultater
    if (ALLOWED_FOOTBALL.some(kw => text.includes(kw))) return false;
    return true;
  }
  return false;
}

// Sorter artikler: norske kilder først, deretter resten alfabetisk
function sortBySource(items) {
  return [...items].sort((a, b) => {
    const ai = NORWEGIAN_SOURCES.indexOf(a.source);
    const bi = NORWEGIAN_SOURCES.indexOf(b.source);
    if (ai !== -1 && bi !== -1) return ai - bi;       // begge norske: behold rekkefølge
    if (ai !== -1) return -1;                          // a er norsk, b ikke
    if (bi !== -1) return 1;                           // b er norsk, a ikke
    return a.source.localeCompare(b.source);           // begge utenlandske: alfabetisk
  });
}

// ── Dedup ─────────────────────────────────────────────────────────────────────

function normalizeTitle(t) {
  return (t||'').toLowerCase()
    .replace(/[«»""''„"]/g, '').replace(/[-–—:,!?.]/g, ' ').replace(/\s+/g, ' ').trim();
}

function sentKey(item) {
  return 'T::' + normalizeTitle(item.title).split(' ').filter(w => w.length > 3).sort().join(' ');
}

function dedupItems(items) {
  const seen = [];
  return items.filter(item => {
    const url   = item.link ? item.link.split('?')[0].toLowerCase() : null;
    const words = new Set(normalizeTitle(item.title).split(' ').filter(w => w.length > 3));
    for (const s of seen) {
      if (url && s.url && url === s.url) return false;
      if (words.size > 2 && s.words.size > 2) {
        const overlap = [...words].filter(w => s.words.has(w)).length;
        if (overlap / Math.max(words.size, s.words.size) >= 0.7) return false;
      }
    }
    seen.push({ url, words });
    return true;
  });
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
        'Accept-Language': 'nb,no;q=0.9,en;q=0.8',
      },
      timeout: 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => resolve(Buffer.concat(c).toString('utf-8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpsPost(hostname, p, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname, path: p, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

// ── RSS ───────────────────────────────────────────────────────────────────────

function decode(s) {
  return (s||'')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function resolveGoogleNewsUrl(link) {
  // Følg redirect fra Google News for å få ekte URL
  return new Promise((resolve) => {
    try {
      const req = https.get(link, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 5000,
      }, res => {
        res.resume();
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(res.headers.location);
        } else {
          resolve(link);
        }
      });
      req.on('error', () => resolve(link));
      req.on('timeout', () => { req.destroy(); resolve(link); });
    } catch (e) { resolve(link); }
  });
}

function cleanLink(link) {
  if (!link) return '';
  if (link.includes('news.google.com')) {
    try { const u = new URL(link); const orig = u.searchParams.get('url'); if (orig) return orig; } catch (e) {}
    // Returner Google News-lenken midlertidig, resolves asynkront i fetchFeeds
    return link;
  }
  return link;
}

function parseRSS(xml, src) {
  const items = [];
  const isAtom = xml.includes('xmlns="http://www.w3.org/2005/Atom"');
  if (isAtom) {
    const re = /<entry>([\s\S]*?)<\/entry>/gi; let m;
    while ((m = re.exec(xml)) !== null) {
      const b = m[1];
      const gt = tag => { const r = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')); return r ? decode(r[1].replace(/<[^>]+>/g,'').trim()) : ''; };
      const title = gt('title'); if (!title) continue;
      const lm = b.match(/<link[^>]+href=["']([^"']+)["']/i);
      items.push({ source:src, title, description:(gt('summary')||gt('content')).replace(/\s+/g,' ').trim().slice(0,250), link:cleanLink(lm?lm[1]:''), pubDate:(gt('published')||gt('updated')).slice(0,25), routes:[] });
      if (items.length >= 25) break;
    }
  } else {
    const re = /<item>([\s\S]*?)<\/item>/gi; let m;
    while ((m = re.exec(xml)) !== null) {
      const b = m[1];
      const g = tag => { const r = b.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i')); return r ? decode((r[1]||r[2]||'').trim()) : ''; };
      const title = g('title'); if (!title) continue;
      items.push({ source:src, title, description:g('description').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0,250), link:cleanLink(g('link')||g('guid')), pubDate:g('pubDate').slice(0,25), routes:[] });
      if (items.length >= 25) break;
    }
  }
  return items;
}

function applyRoutes(items) {
  for (const it of items) {
    const txt = (it.title + ' ' + it.description).toLowerCase();
    it.routes = ROUTES.filter(r => r.keywords.some(k => txt.includes(k))).map(r => r.name);
  }
  return items;
}

async function fetchFeeds(cat) {
  const active = FEEDS.filter(f => f.cat === cat && (cat !== 'nyheter' || ENABLED_FEEDS.includes(f.name)));
  const results = [], errors = [];
  await Promise.all(active.map(async feed => {
    try { results.push(...parseRSS(await fetchUrl(feed.url), feed.name)); }
    catch (e) { errors.push(`${feed.name}: ${e.message}`); console.error(`  ✗ ${feed.name}: ${e.message}`); }
  }));
  applyRoutes(results);

  // Løs opp Google News redirect-URLer for AP News
  await Promise.all(results.map(async item => {
    if (item.link && item.link.includes('news.google.com')) {
      item.link = await resolveGoogleNewsUrl(item.link);
    }
  }));

  return { items: dedupItems(results), errors };
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

async function refreshAccessToken() {
  const cred  = loadCreds();
  const token = loadToken();
  if (!token.refresh_token) throw new Error('Ingen refresh_token – koble til Gmail på nytt i appen og oppdater GMAIL_TOKEN-secret');
  const r = await httpsPost('oauth2.googleapis.com', '/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    `client_id=${encodeURIComponent(cred.client_id)}&client_secret=${encodeURIComponent(cred.client_secret)}&refresh_token=${encodeURIComponent(token.refresh_token)}&grant_type=refresh_token`
  );
  const d = JSON.parse(r.body);
  if (!d.access_token) {
    const msg = `Gmail token er utløpt og må fornyes.\n\nFeil: ${d.error} – ${d.error_description}\n\nSlik fikser du det:\n1. Åpne Nyhetsagent-appen på PC-en\n2. Gå til Innstillinger → Koble til Gmail\n3. Gå til myaccount.google.com/permissions → fjern Nyhetsagent\n4. Koble til Gmail på nytt i appen\n5. Kopier innholdet av Dokumenter\\Nyhetsagent\\gmail_token.json\n6. Oppdater GMAIL_TOKEN-secret på GitHub`;
    // Prøv å sende varsel via SMTP direkte (uten Gmail API siden token er ugyldig)
    // Logg tydelig til GitHub Actions slik at du ser det i Actions-loggen
    console.error('\n⚠️  GMAIL TOKEN UTLØPT – MÅ FORNYES\n');
    console.error(msg);
    console.error('\nSjekk Actions-loggen på github.com for instruksjoner.\n');
    throw new Error(`Gmail token utløpt (${d.error}) – sjekk Actions-loggen for instruksjoner`);
  }
  token.access_token = d.access_token;
  token.expiry_date  = Date.now() + (d.expires_in||3600) * 1000;
  if (d.refresh_token) token.refresh_token = d.refresh_token;
  _token = token;
  return token.access_token;
}

async function getAccessToken() {
  const token = loadToken();
  if (Date.now() > (token.expiry_date||0) - 60000) return refreshAccessToken();
  return token.access_token;
}

async function sendGmail(to, subject, bodyText) {
  const accessToken = await getAccessToken();
  const subjectB64  = '=?utf-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';
  const html = '<html><body><pre style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap;word-wrap:break-word">'
    + bodyText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    + '</pre></body></html>';
  const raw = Buffer.from(
    `From: me\r\nTo: ${to}\r\nSubject: ${subjectB64}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`
    + Buffer.from(html, 'utf-8').toString('base64')
  ).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ raw });
    const req = https.request({
      hostname: 'gmail.googleapis.com',
      path: '/gmail/v1/users/me/messages/send',
      method: 'POST',
      headers: { 'Authorization':`Bearer ${accessToken}`, 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(payload) }
    }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Gmail send feilet: HTTP ${res.statusCode} – ${Buffer.concat(c).toString()}`));
      });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

// ── AI ────────────────────────────────────────────────────────────────────────

async function aiSummary(items) {
  if (!ANTHROPIC) return null;
  try {
    const heads = items.slice(0,30).map(i => `[${i.source}] ${i.title}: ${(i.description||'').slice(0,80)}`).join('\n');
    const r = await httpsPost('api.anthropic.com', '/v1/messages',
      { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC, 'anthropic-version':'2023-06-01' },
      JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:600, messages:[{ role:'user', content:`Lag en kort norsk nyhetsoppsummering med 5-7 kulepunkter av de viktigste nyhetene:\n\n${heads}` }] })
    );
    return JSON.parse(r.body).content?.[0]?.text || null;
  } catch (e) { console.error('AI feilet:', e.message); return null; }
}

function buildBody(label, items, summary) {
  const now      = new Date().toLocaleString('nb-NO', { timeZone:'Europe/Oslo' });
  const sorted   = sortBySource(items.slice(0,25));
  const itemList = sorted.map(i =>
    `• [${i.source}] ${i.title}${i.link ? '\n  ' + i.link : ''}`
  ).join('\n\n');
  return summary
    ? `${label} – ${now}\n\n${summary}\n\n─────────\nAlle saker (${Math.min(items.length,25)}):\n\n${itemList}\n\n─────\nNyhetsagent`
    : `${label} – ${now}\n\n${itemList}\n\n─────\nNyhetsagent`;
}

// ── Moduser ───────────────────────────────────────────────────────────────────

async function runAlerts() {
  console.log('Modus: varsler');
  if (!EMAIL_TO) throw new Error('EMAIL_TO mangler');
  const { items, errors } = await fetchFeeds('nyheter');
  console.log(`Hentet ${items.length} artikler (${errors.length} feil)`);
  const sent     = loadSent();
  const filtered = dedupItems(items.filter(i => !shouldFilter(i)).filter(i => !sent[sentKey(i)]));
  console.log(`Nye å sende: ${filtered.length}`);
  if (!filtered.length) { console.log('Ingenting nytt.'); return; }
  try {
    if (fs.existsSync(LAST_FILE)) {
      const last = JSON.parse(fs.readFileSync(LAST_FILE, 'utf-8')).ts || 0;
      if (Date.now() - last < 110 * 60 * 1000) { console.log('For tidlig siden siste sending.'); return; }
    }
  } catch (e) {}
  const now     = new Date().toLocaleString('nb-NO', { timeZone:'Europe/Oslo' });
  const sorted  = sortBySource(filtered);
  const grouped = sorted.reduce((acc, i) => { (acc[i.source] = acc[i.source]||[]).push(i); return acc; }, {});
  // Bygg e-post med norske kilder øverst
  const sourceOrder = [...new Set(sorted.map(i => i.source))];
  const body = sourceOrder.map(src =>
    `━━ ${src} ━━\n` + grouped[src].map(i =>
      `• ${i.title}${i.description ? '\n  ' + i.description.slice(0,150) : ''}${i.link ? '\n  ' + i.link : ''}`
    ).join('\n\n')
  ).join('\n\n');
  await sendGmail(EMAIL_TO, `Nyhetsagent: ${filtered.length} nye varsler – ${now}`, body);
  console.log(`✓ Sendt ${filtered.length} varsler`);
  filtered.forEach(i => { sent[sentKey(i)] = Date.now(); if (i.link) sent[i.link.split('?')[0].toLowerCase()] = Date.now(); });
  saveSent(sent);
  fs.writeFileSync(LAST_FILE, JSON.stringify({ ts: Date.now() }));
}

async function runMorning() {
  console.log('Modus: morgenoppsummering');
  if (!EMAIL_TO) throw new Error('EMAIL_TO mangler');
  const { items, errors } = await fetchFeeds('nyheter');
  console.log(`Hentet ${items.length} artikler (${errors.length} feil)`);
  const cutTime = Date.now() - 10 * 60 * 60 * 1000;
  const sent    = loadSent();
  const night   = dedupItems(
    items
      .filter(i => { const t = new Date(i.pubDate).getTime(); return isNaN(t) || t > cutTime; })
      .filter(i => !shouldFilter(i))
      .filter(i => !sent[sentKey(i)])
  );
  console.log(`Nattens nyheter: ${night.length}`);
  if (!night.length) { console.log('Ingen nattlige nyheter.'); return; }
  const summary = await aiSummary(night);
  const dateStr = new Date().toLocaleDateString('nb-NO', { timeZone:'Europe/Oslo' });
  await sendGmail(EMAIL_TO, `Morgenoppsummering – ${dateStr}`, buildBody('Morgenoppsummering', night, summary));
  console.log(`✓ Morgenoppsummering sendt (${night.length} saker)`);
  night.forEach(i => { sent[sentKey(i)] = Date.now(); if (i.link) sent[i.link.split('?')[0].toLowerCase()] = Date.now(); });
  saveSent(sent);
}

async function runEvening() {
  console.log('Modus: kveldoppsummering');
  if (!EMAIL_TO) throw new Error('EMAIL_TO mangler');
  const { items, errors } = await fetchFeeds('nyheter');
  console.log(`Hentet ${items.length} artikler (${errors.length} feil)`);
  const sent = loadSent();
  const day  = dedupItems(items.filter(i => !shouldFilter(i)).filter(i => !sent[sentKey(i)]));
  console.log(`Usendte dagsaker: ${day.length}`);
  if (!day.length) { console.log('Ingen nye dagsaker.'); return; }
  const summary = await aiSummary(day);
  const dateStr = new Date().toLocaleDateString('nb-NO', { timeZone:'Europe/Oslo' });
  await sendGmail(EMAIL_TO, `Kveldoppsummering – ${dateStr}`, buildBody('Kveldoppsummering', day, summary));
  console.log(`✓ Kveldoppsummering sendt (${day.length} saker)`);
  day.forEach(i => { sent[sentKey(i)] = Date.now(); if (i.link) sent[i.link.split('?')[0].toLowerCase()] = Date.now(); });
  saveSent(sent);
}

async function runWeekly() {
  console.log('Modus: ukentlig');
  if (!EMAIL_TO) throw new Error('EMAIL_TO mangler');
  const [{ items: film }, { items: musikk }] = await Promise.all([fetchFeeds('film'), fetchFeeds('musikk')]);
  let spotifyList = null;
  if (SPOTIFY_ID && SPOTIFY_SC) {
    try {
      const tr = await httpsPost('accounts.spotify.com', '/api/token',
        { 'Content-Type':'application/x-www-form-urlencoded', 'Authorization':'Basic ' + Buffer.from(`${SPOTIFY_ID}:${SPOTIFY_SC}`).toString('base64') },
        'grant_type=client_credentials'
      );
      const { access_token } = JSON.parse(tr.body);
      const get = p => new Promise((res, rej) => {
        const req = https.request({ hostname:'api.spotify.com', path:p, headers:{ 'Authorization':`Bearer ${access_token}` } }, resp => {
          const c = []; resp.on('data', d => c.push(d)); resp.on('end', () => res(JSON.parse(Buffer.concat(c).toString())));
        }); req.on('error', rej); req.end();
      });
      const pl = await get('/v1/playlists/37i9dQZEVXbMDoHDwVN2tF/tracks?limit=50&fields=items(track(name,artists,popularity))');
      spotifyList = (pl.items||[]).map(i => i.track).filter(Boolean)
        .sort((a, b) => b.popularity - a.popularity).slice(0, 20)
        .map((t, i) => `${i+1}. ${t.name} – ${t.artists.map(a => a.name).join(', ')}`).join('\n');
    } catch (e) { console.error('Spotify feilet:', e.message); }
  }
  const now   = new Date().toLocaleString('nb-NO', { timeZone:'Europe/Oslo' });
  const parts = [`Ukentlig oppsummering – ${now}\n`];
  if (film.length)   parts.push('═══ FILM & SERIER ═══\n' + film.slice(0,15).map(i => `• [${i.source}] ${i.title}${i.link ? '\n  ' + i.link : ''}`).join('\n\n'));
  if (musikk.length) parts.push('\n\n═══ MUSIKK ═══\n' + musikk.slice(0,15).map(i => `• [${i.source}] ${i.title}${i.link ? '\n  ' + i.link : ''}`).join('\n\n'));
  if (spotifyList)   parts.push('\n\n═══ SPOTIFY – TRENDENDE LÅTER ═══\n' + spotifyList);
  parts.push('\n\n─────\nNyhetsagent');
  const dateStr = new Date().toLocaleDateString('nb-NO', { timeZone:'Europe/Oslo' });
  await sendGmail(EMAIL_TO, `Ukentlig oppsummering – ${dateStr}`, parts.join('\n'));
  console.log('✓ Ukentlig sendt');
}

// ── Start ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\nNyhetsagent [${MODE}] – ${new Date().toLocaleString('nb-NO', { timeZone:'Europe/Oslo' })}\n`);
  try {
    if      (MODE === 'morning') await runMorning();
    else if (MODE === 'evening') await runEvening();
    else if (MODE === 'weekly')  await runWeekly();
    else                         await runAlerts();
    console.log('\nFerdig.');
  } catch (e) {
    console.error('\nFEIL:', e.message);
    if (e.message.includes('token utløpt') || e.message.includes('refresh_token') || e.message.includes('invalid_grant')) {
      console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.error('GMAIL TOKEN MÅ FORNYES – følg disse stegene:');
      console.error('1. Åpne Nyhetsagent-appen på PC-en');
      console.error('2. Gå til myaccount.google.com/permissions');
      console.error('3. Fjern tilgangen til Nyhetsagent');
      console.error('4. Koble til Gmail på nytt i appen');
      console.error('5. Kopier innhold av Dokumenter\\Nyhetsagent\\gmail_token.json');
      console.error('6. Oppdater GMAIL_TOKEN-secret på GitHub under Settings → Secrets');
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    }
    process.exit(1);
  }
})();
