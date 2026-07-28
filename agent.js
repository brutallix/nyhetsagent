#!/usr/bin/env node
/**
 * Nyhetsagent — GitHub Actions-versjon
 * Kjøres headless (ingen Electron/UI). Secrets kommer fra miljøvariabler,
 * "sent"-historikk og cache lagres i state/-mappen og committes tilbake til repoet
 * av workflow-filen etter hver kjøring.
 *
 * Bruk: node agent.js <morning|evening|weekly|test>
 */
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const MODE = (process.argv[2] || 'morning').toLowerCase();

// ── Secrets / config fra miljøvariabler ─────────────────────────────────────────

const EMAIL_TO              = process.env.EMAIL_TO || '';
const ANTHROPIC_KEY         = process.env.ANTHROPIC_KEY || '';
const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';

function requiredJson(envVar) {
  const raw = process.env[envVar];
  if (!raw) throw new Error(`Secret ${envVar} mangler`);
  try { return JSON.parse(raw); } catch (e) { throw new Error(`Secret ${envVar} er ikke gyldig JSON`); }
}

// ── Feeds ────────────────────────────────────────────────────────────────────────

const FEEDS = [
  { name:'NRK',          url:'https://www.nrk.no/nyheter/siste.rss',            cat:'nyheter' },
  { name:'Aftenposten',  url:'https://www.aftenposten.no/rss',                   cat:'nyheter' },
  { name:'VG',           url:'https://www.vg.no/rss/feed/',                      cat:'nyheter' },
  { name:'TV2',          url:'https://www.tv2.no/rss/nyheter',                   cat:'nyheter' },
  { name:'E24',          url:'https://e24.no/rss',                               cat:'nyheter' },
  { name:'Nettavisen',   url:'https://www.nettavisen.no/service/rss',            cat:'nyheter' },
  { name:'TLDR Tech',    url:'https://tldr.tech/api/rss/tech',                   cat:'nyheter' },
  { name:'TLDR AI',      url:'https://tldr.tech/api/rss/ai',                     cat:'nyheter' },
  { name:'Wired',        url:'https://www.wired.com/feed/rss',                   cat:'nyheter' },
  { name:'Ars Technica', url:'https://feeds.arstechnica.com/arstechnica/index',  cat:'nyheter' },
  { name:'TechCrunch',   url:'https://techcrunch.com/feed/',                     cat:'nyheter' },
  { name:'MIT Tech Review',url:'https://www.technologyreview.com/feed/',         cat:'nyheter' },
  { name:'BBC News',     url:'https://feeds.bbci.co.uk/news/rss.xml',            cat:'nyheter' },
  { name:'BBC Europa',   url:'https://feeds.bbci.co.uk/news/world/europe/rss.xml',cat:'nyheter'},
  { name:'BBC USA',      url:'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml',cat:'nyheter'},
  { name:'Euronews',     url:'https://www.euronews.com/rss?format=mrss&level=theme&name=news', cat:'nyheter' },
  { name:'AP News',      url:'https://news.google.com/rss/search?q=site:apnews.com&hl=en-US&gl=US&ceid=US:en', cat:'nyheter'},
  { name:'Deadline',     url:'https://deadline.com/feed',                        cat:'nyheter' },
  { name:'Hollywood Reporter',url:'https://www.hollywoodreporter.com/feed/',     cat:'nyheter' },
  { name:'Variety',      url:'https://variety.com/feed/',                        cat:'nyheter' },
  { name:'HollywoodLife',url:'https://hollywoodlife.com/feed/',                  cat:'nyheter' },
  { name:'Just Jared',   url:'https://www.justjared.com/feed/',                  cat:'nyheter' },
  { name:'E! Online',    url:'https://www.eonline.com/syndication/feeds/rssfeeds/topstories.xml', cat:'nyheter'},
  { name:'Roger Ebert',   url:'https://www.rogerebert.com/feed',                  cat:'film' },
  { name:'Slash Film',    url:'https://www.slashfilm.com/feed/',                   cat:'film' },
  { name:'Film Inquiry',  url:'https://filminquiry.com/feed/',                     cat:'film' },
  { name:'Movieweb',      url:'https://movieweb.com/feed/',                        cat:'film' },
  { name:'Cinelinx',      url:'https://www.cinelinx.com/feed/',                    cat:'film' },
  { name:'The Credits',   url:'https://thecredits.org/feed/',                      cat:'film' },
  { name:'Pitchfork',     url:'https://pitchfork.com/feed/rss',                    cat:'musikk' },
  { name:'Consequence',   url:'https://consequenceofsound.net/feed/',              cat:'musikk' },
  { name:'Metal Injection',url:'https://metalinjection.net/feed',                  cat:'musikk' },
  { name:'Sputnikmusic',  url:'https://www.sputnikmusic.com/rss.php',              cat:'musikk' },
  { name:'PopMatters',    url:'https://www.popmatters.com/feed/',                  cat:'musikk' },
  { name:'Chorus.fm',     url:'https://chorus.fm/feed/',                           cat:'musikk' },
];

// Bare "nyheter"-feeder brukes for daglige oppsummeringer
const ENABLED_NEWS_FEEDS = FEEDS.filter(f => f.cat === 'nyheter').map(f => f.name);

const ROUTES = [
  { name:'Politikk', keywords:['regjeringen','stortinget','statsminister','valg','minister','høyre','frp','arbeiderpartiet','government','election','president','congress','trump'] },
  { name:'Økonomi',  keywords:['økonomi','rente','inflasjon','børs','oljepris','budsjett','skatt','aksjer','economy','inflation','stock','market','fed','tariff'] },
  { name:'Krim',     keywords:['politi','arrestert','drap','ran','siktet','tiltalt','skadet','savnet','police','arrested','murder','shooting','killed','suspect','crime'] },
  { name:'AI',       keywords:['artificial intelligence','machine learning','chatgpt','openai','anthropic','gemini','llm','claude','gpt','nvidia','ai model','generative'] },
  { name:'Underholdning', keywords:['celebrity','hollywood','kardashian','taylor swift','netflix','movie','film','award','grammy','oscar','trailer','streaming','singer','actor'] },
];

// ── State-filer (persisteres via git commit i workflow) ─────────────────────────

const STATE_DIR        = path.join(__dirname, 'state');
const SENT_FILE         = path.join(STATE_DIR, 'sent_links.json');
const CACHE_FILE        = path.join(STATE_DIR, 'latest.json');
const LAST_EMAIL_FILE   = path.join(STATE_DIR, 'last_email.json');

function ensureDir() { if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true }); }

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
function saveSent(d) { ensureDir(); fs.writeFileSync(SENT_FILE, JSON.stringify(d, null, 2), 'utf-8'); }

// ── HTTP ─────────────────────────────────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9,nb;q=0.8',
      },
      timeout: 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c).toString('utf-8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpsPost(hostname, p, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({ hostname, path: p, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } }, res => {
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

// ── RSS parsing ────────────────────────────────────────────────────────────────

function decode(s) {
  return (s || '')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
}

function cleanLink(link) {
  if (!link) return '';
  if (link.includes('news.google.com')) {
    try { const u = new URL(link); const orig = u.searchParams.get('url'); if (orig) return orig; } catch (e) {}
    return link.split('?')[0];
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
      const desc  = (gt('summary')||gt('content')).replace(/\s+/g,' ').trim().slice(0,250);
      const lm    = b.match(/<link[^>]+href=["']([^"']+)["']/i);
      items.push({ source:src, title, description:desc, link:cleanLink(lm?lm[1]:''), pubDate:(gt('published')||gt('updated')).slice(0,25), routes:[] });
      if (items.length >= 20) break;
    }
  } else {
    const re = /<item>([\s\S]*?)<\/item>/gi; let m;
    while ((m = re.exec(xml)) !== null) {
      const b = m[1];
      const g = tag => { const r = b.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i')); return r ? decode((r[1]||r[2]||'').trim()) : ''; };
      const title = g('title'); if (!title) continue;
      const desc  = g('description').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0,250);
      items.push({ source:src, title, description:desc, link:cleanLink(g('link')||g('guid')), pubDate:g('pubDate').slice(0,25), routes:[] });
      if (items.length >= 20) break;
    }
  }
  return items;
}

function applyRoutes(items) {
  for (const it of items) {
    const txt = (it.title+' '+it.description).toLowerCase();
    it.routes = ROUTES.filter(r => r.keywords.some(k => txt.includes(k))).map(r => r.name);
  }
  return items;
}

// ── Deduplisering ────────────────────────────────────────────────────────────────

function normalizeTitle(t) {
  return (t||'')
    .toLowerCase()
    .replace(/[«»""''„"]/g, '')
    .replace(/[-–—:,!?.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function sentKey(item) {
  return 'T::' + normalizeTitle(item.title).split(' ').filter(w => w.length > 3).sort().join(' ');
}

// ── Innholdsfiltre ────────────────────────────────────────────────────────────

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
  'belle delphine','corpse husband','dream smp',
];

function isRealityNews(item) {
  const text = ((item.title||'') + ' ' + (item.description||'')).toLowerCase();
  return REALITY_KEYWORDS.some(kw => text.includes(kw));
}
function isSportNews(item) {
  const text = ((item.title||'') + ' ' + (item.description||'')).toLowerCase();
  if (!SPORT_KEYWORDS.some(kw => text.includes(kw))) return false;
  if (NORWAY_NATIONAL_TEAM.some(kw => text.includes(kw))) return false;
  return true;
}
function isInfluencerNews(item) {
  const text = ((item.title||'') + ' ' + (item.description||'')).toLowerCase();
  return INFLUENCER_KEYWORDS.some(kw => text.includes(kw));
}
function shouldFilter(item) {
  return isRealityNews(item) || isSportNews(item) || isInfluencerNews(item);
}

function dedupItems(items) {
  const seen = [];
  return items.filter(item => {
    const url  = item.link ? item.link.split('?')[0].toLowerCase() : null;
    const norm = normalizeTitle(item.title);
    const words = new Set(norm.split(' ').filter(w => w.length > 3));
    for (const s of seen) {
      if (url && s.url && url === s.url) return false;
      if (words.size > 2 && s.words.size > 2) {
        const overlap = [...words].filter(w => s.words.has(w)).length;
        const ratio   = overlap / Math.max(words.size, s.words.size);
        if (ratio >= 0.7) return false;
      }
    }
    seen.push({ url, words });
    return true;
  });
}

// ── Fetch ────────────────────────────────────────────────────────────────────────

async function fetchNewsFeeds() {
  const active = FEEDS.filter(f => f.cat === 'nyheter' && ENABLED_NEWS_FEEDS.includes(f.name));
  const results = [], errors = [];
  await Promise.all(active.map(async feed => {
    try { results.push(...parseRSS(await fetchUrl(feed.url), feed.name)); }
    catch (e) { errors.push(`${feed.name}: ${e.message}`); }
  }));
  applyRoutes(results);
  const deduped = dedupItems(results);
  ensureDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ generated: new Date().toISOString(), total: deduped.length, errors, items: deduped }, null, 2), 'utf-8');
  return { items: deduped, errors };
}

async function fetchCat(feedList) {
  const all = [];
  await Promise.all(feedList.map(async f => { try { all.push(...parseRSS(await fetchUrl(f.url), f.name)); } catch (e) {} }));
  return all;
}

// ── Gmail (OAuth2, refresh_token-basert — ingen lokal token-fil nødvendig) ───────

function getGmailCreds() { return requiredJson('GMAIL_CREDENTIALS').installed || requiredJson('GMAIL_CREDENTIALS').web; }

async function getFreshAccessToken() {
  const raw   = requiredJson('GMAIL_CREDENTIALS');
  const cred  = raw.installed || raw.web;
  if (!cred) throw new Error('Ugyldig GMAIL_CREDENTIALS secret');
  const token = requiredJson('GMAIL_TOKEN');
  if (!token.refresh_token) throw new Error('GMAIL_TOKEN mangler refresh_token');

  const r = await httpsPost('oauth2.googleapis.com', '/token', { 'Content-Type':'application/x-www-form-urlencoded' },
    `client_id=${encodeURIComponent(cred.client_id)}&client_secret=${encodeURIComponent(cred.client_secret)}&refresh_token=${encodeURIComponent(token.refresh_token)}&grant_type=refresh_token`);
  const d = JSON.parse(r.body);
  if (!d.access_token) throw new Error('Klarte ikke fornye Gmail-token: ' + (d.error_description || r.body));
  return d.access_token;
}

async function sendGmail(to, subject, body) {
  const accessToken = await getFreshAccessToken();
  const subjectEncoded = '=?utf-8?B?' + Buffer.from(subject,'utf-8').toString('base64') + '?=';
  const htmlBody = '<html><body><pre style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap;word-wrap:break-word">'
    + body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    + '</pre></body></html>';
  const raw = Buffer.from(
    `From: me\r\nTo: ${to}\r\nSubject: ${subjectEncoded}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`
    + Buffer.from(htmlBody,'utf-8').toString('base64')
  ).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const payload = JSON.stringify({ raw });
  const res = await new Promise((resolve, reject) => {
    const req = https.request({ hostname:'gmail.googleapis.com', path:'/gmail/v1/users/me/messages/send', method:'POST',
      headers:{ 'Authorization':`Bearer ${accessToken}`, 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(payload) } },
      r => { const c=[]; r.on('data',d=>c.push(d)); r.on('end',()=>resolve({status:r.statusCode, body:Buffer.concat(c).toString()})); });
    req.on('error', reject); req.write(payload); req.end();
  });
  if (res.status >= 400) throw new Error(`Gmail API ${res.status}: ${res.body}`);
}

// ── Daglig oppsummering (morning / evening) ──────────────────────────────────────

async function sendDailySummary(hour) {
  if (!EMAIL_TO) throw new Error('EMAIL_TO mangler');
  const label = hour < 12 ? 'Morgenoppsummering' : 'Kveldoppsummering';
  const now   = new Date().toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' });

  const sent = loadSent();
  const { items: fresh } = await fetchNewsFeeds();
  const items = dedupItems(fresh.filter(i => !shouldFilter(i)).filter(i => !sent[sentKey(i)]));

  if (!items.length) { console.log(`[${label}] Ingen nye saker å sende.`); return; }

  const topItems = items.slice(0, 20);
  let aiSummary = null;
  if (ANTHROPIC_KEY) {
    try {
      const heads = topItems.map(i => `[${i.source}] ${i.title}: ${(i.description||'').slice(0,80)}`).join('\n');
      const r = await httpsPost('api.anthropic.com', '/v1/messages',
        { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
        JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:600, messages:[{ role:'user',
          content:`Lag en kort norsk nyhetsoppsummering med 5-7 kulepunkter av de viktigste nyhetene:\n\n${heads}` }] })
      );
      const p = JSON.parse(r.body);
      if (p.content?.[0]?.text) aiSummary = p.content[0].text;
    } catch (e) { console.error('[AI-oppsummering feilet]', e.message); }
  }

  const itemList = topItems.map(i => `• [${i.source}] ${i.title}${i.link ? '\n  ' + i.link : ''}`).join('\n\n');
  const body = aiSummary
    ? `${label} – ${now}\n\n${aiSummary}\n\n─────────\nAlle saker (${topItems.length}):\n\n${itemList}\n\n─────\nNyhetsagent`
    : `${label} – ${now}\n\n${itemList}\n\n─────\nNyhetsagent`;

  await sendGmail(EMAIL_TO, `${label} – ${now.slice(0,10)}`, body);
  console.log(`[${label}] Sendt (${topItems.length} saker).`);

  topItems.forEach(i => { sent[sentKey(i)] = Date.now(); if (i.link) sent[i.link.split('?')[0].toLowerCase()] = Date.now(); });
  saveSent(sent);
}

// ── Ukentlig oppsummering ─────────────────────────────────────────────────────────

function weekNum(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  dt.setUTCDate(dt.getUTCDate()+4-(dt.getUTCDay()||7));
  return Math.ceil((((dt-new Date(Date.UTC(dt.getUTCFullYear(),0,1)))/86400000)+1)/7);
}

async function spotifyToken() {
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const r = await httpsPost('accounts.spotify.com', '/api/token',
    { 'Content-Type':'application/x-www-form-urlencoded', 'Authorization':`Basic ${creds}` }, 'grant_type=client_credentials');
  const d = JSON.parse(r.body);
  if (!d.access_token) throw new Error('Spotify token feil');
  return d.access_token;
}
function spotifyGet(p, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname:'api.spotify.com', path:p, headers:{ 'Authorization':`Bearer ${token}` } }, res => {
      const c=[]; res.on('data',d=>c.push(d)); res.on('end',()=>resolve(JSON.parse(Buffer.concat(c).toString())));
    });
    req.on('error', reject); req.end();
  });
}
async function spotifyTrending() {
  const token  = await spotifyToken();
  const pl     = await spotifyGet('/v1/playlists/37i9dQZEVXbMDoHDwVN2tF/tracks?limit=50&fields=items(track(id,name,artists,popularity))', token);
  const tracks = (pl.items||[]).map(i=>i.track).filter(Boolean);
  const aids   = [...new Set(tracks.flatMap(t=>t.artists.map(a=>a.id)))].slice(0,50);
  const ad     = await spotifyGet(`/v1/artists?ids=${aids.join(',')}`, token);
  const ag     = {};
  (ad.artists||[]).forEach(a => { if (a) ag[a.id]=a.genres||[]; });
  const tg = ['pop','rock','metal','punk','indie','alternative','hard rock','heavy metal','electropop'];
  return tracks.map(t => {
    const genres = t.artists.flatMap(a=>ag[a.id]||[]);
    const g = genres.find(x=>tg.some(tg=>x.includes(tg)))||'';
    return { id:t.id, name:t.name, artist:t.artists.map(a=>a.name).join(', '), popularity:t.popularity, genres:g };
  }).filter(t=>t.genres||t.popularity>70).sort((a,b)=>b.popularity-a.popularity).slice(0,20);
}

async function sendWeeklySummary() {
  if (!EMAIL_TO) throw new Error('EMAIL_TO mangler');
  const now     = new Date().toLocaleString('nb-NO', { timeZone:'Europe/Oslo' });
  const weekStr = `Uke ${weekNum(new Date())} – ${now.slice(0,10)}`;

  const filmFeeds  = FEEDS.filter(f => f.cat === 'film');
  const musikFeeds = FEEDS.filter(f => f.cat === 'musikk');
  const [filmItems, musikItems] = await Promise.all([fetchCat(filmFeeds), fetchCat(musikFeeds)]);

  const tkw = ['trailer','teaser','first look','official','preview'];
  const tvkw = ['series','show','season','episode'];
  const revkw = ['review','rated','score','stars'];
  const albkw = ['album','release','new music','single','ep','out now'];
  const mrkw = ['metal','rock','punk','hardcore','heavy'];
  const txt = i => (i.title+' '+(i.description||'')).toLowerCase();
  const match = (i,kws) => kws.some(k => txt(i).includes(k));

  const filmTrailers = filmItems.filter(i => match(i,tkw) && !match(i,tvkw));
  const tvTrailers   = filmItems.filter(i => match(i,tkw) &&  match(i,tvkw));
  const reviews      = filmItems.filter(i => match(i,revkw));
  const albums       = musikItems.filter(i => match(i,albkw));
  const metalRock    = musikItems.filter(i => match(i,mrkw));

  let body = `UKENTLIG OPPSUMMERING – ${weekStr}\n${'═'.repeat(45)}\n\n`;

  if (ANTHROPIC_KEY) {
    try {
      const heads = [...reviews.slice(0,10).map(i=>`[Film] ${i.title}`), ...albums.slice(0,10).map(i=>`[Album] ${i.title}`)].join('\n');
      const r = await httpsPost('api.anthropic.com', '/v1/messages',
        { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
        JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:600, messages:[{ role:'user', content:`Uke-oppsummering på norsk av ukens film- og musikknyheter:\n\n${heads}\n\nSeksjoner: 1) Filmer i kino (med score hvis nevnt) 2) Anbefalte album (pop/rock/metal). Maks 250 ord.` }] })
      );
      const p = JSON.parse(r.body);
      if (p.content?.[0]?.text) body += p.content[0].text + '\n\n' + '─'.repeat(45) + '\n\n';
    } catch (e) { console.error('[Ukentlig AI feilet]', e.message); }
  }

  const section = (emoji, title, items, withDesc) => {
    if (!items.length) return '';
    let s = `${emoji} ${title}\n${'─'.repeat(30)}\n`;
    items.slice(0,8).forEach(i => {
      s += `• ${i.title}\n`;
      if (withDesc && i.description) s += `  ${i.description.slice(0,100)}\n`;
      if (i.link) s += `  ${i.link}\n`;
    });
    return s + '\n';
  };

  body += section('🎬','NYE FILMTRAILERE', filmTrailers, false);
  body += section('📺','NYE TV-SERIE TRAILERE', tvTrailers, false);
  body += section('⭐','FILMANMELDELSER', reviews, true);
  body += section('🎸','NYE ALBUM (POP / ROCK / METAL)', [...new Map([...albums,...metalRock].map(i=>[i.link,i])).values()], true);

  if (SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET) {
    try {
      const tracks = await spotifyTrending();
      if (tracks.length) {
        body += `🎵 TRENDENDE LÅTER\n${'─'.repeat(30)}\n`;
        tracks.forEach((t,i) => { body += `${i+1}. ${t.artist} – ${t.name}\n   https://open.spotify.com/track/${t.id}\n`; });
        body += '\n';
      }
    } catch (e) { console.error('[Spotify feilet]', e.message); }
  }

  body += '─'.repeat(45) + '\nNyhetsagent';
  await sendGmail(EMAIL_TO, `Ukentlig oppsummering – ${weekStr}`, body);
  console.log('[Ukentlig oppsummering] Sendt.');
}

// ── Main ─────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Nyhetsagent (GitHub Actions) — modus: ${MODE}`);
  ensureDir();
  if (MODE === 'morning')      await sendDailySummary(7);
  else if (MODE === 'evening') await sendDailySummary(22);
  else if (MODE === 'weekly')  await sendWeeklySummary();
  else if (MODE === 'test')    await sendGmail(EMAIL_TO, 'Nyhetsagent testmelding', 'Fungerer! Dette er en testmelding fra GitHub Actions.');
  else throw new Error(`Ukjent modus: ${MODE}. Bruk morning, evening, weekly eller test.`);
}

main().catch(e => { console.error('FEIL:', e.message); process.exit(1); });
