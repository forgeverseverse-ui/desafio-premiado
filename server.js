const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const INDEX = path.join(__dirname, 'index.html');
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 8;

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}
function rateLimit(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (list.length >= MAX_REQUESTS) return false;
  list.push(now); hits.set(ip, list); return true;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 10_000) { reject(new Error('Payload muito grande')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}
function cleanQuestions(raw, category) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 10).filter(q => q && typeof q.q === 'string' && q.q.length <= 300 && Array.isArray(q.a) && q.a.length === 4 && q.a.every(a => typeof a === 'string' && a.length <= 180) && Number.isInteger(q.k) && q.k >= 0 && q.k <= 3 && typeof q.e === 'string' && q.e.length <= 500)
    .map(q => ({ c: String(q.c || category).slice(0, 40), q: q.q, a: q.a, k: q.k, e: q.e }));
}
const allowed = new Set(['Misto', 'Ciência', 'História', 'Brasil', 'Natureza', 'Tecnologia', 'Geografia', 'Cultura']);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pageFiles = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/sobre': ['sobre.html', 'text/html; charset=utf-8'],
    '/privacidade': ['privacidade.html', 'text/html; charset=utf-8'],
    '/termos': ['termos.html', 'text/html; charset=utf-8'],
    '/contato': ['contato.html', 'text/html; charset=utf-8'],
    '/pages.css': ['pages.css', 'text/css; charset=utf-8'],
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    '/icon.svg': ['icon.svg', 'image/svg+xml'],
    '/sw.js': ['sw.js', 'text/javascript; charset=utf-8']
  };
  if (req.method === 'GET' && pageFiles[url.pathname]) {
    try {
      const [file, type] = pageFiles[url.pathname];
      send(res, 200, fs.readFileSync(path.join(__dirname, file), 'utf8'), type);
    } catch { send(res, 500, { error: 'Não foi possível abrir esta página.' }); }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') { send(res, 200, { ok: true, aiConfigured: Boolean(API_KEY) }); return; }
  if (req.method === 'POST' && url.pathname === '/api/questions') {
    if (!rateLimit(req)) { send(res, 429, { error: 'Muitas solicitações. Aguarde um minuto e tente novamente.' }); return; }
    if (!API_KEY) { send(res, 503, { error: 'IA ainda não configurada. Adicione OPENAI_API_KEY nas variáveis de ambiente do servidor.' }); return; }
    try {
      const body = await readBody(req);
      const category = allowed.has(body.category) ? body.category : 'Misto';
      const count = Math.max(5, Math.min(10, Number(body.count) || 10));
      const prompt = `Crie ${count} perguntas originais de quiz em português brasileiro, nível variado, sobre a categoria "${category}". Para Misto, varie os temas. Cada pergunta deve ter exatamente quatro alternativas, apenas uma correta, e uma explicação curta e educativa. Evite política partidária, conteúdo adulto, conselhos médicos/financeiros, fatos controversos ou perguntas dependentes de notícias atuais. Não repita a mesma pergunta dentro desta rodada. Responda APENAS com JSON válido neste formato: {"questions":[{"c":"categoria","q":"pergunta","a":["alternativa A","alternativa B","alternativa C","alternativa D"],"k":0,"e":"explicação"}]}. O índice k da resposta correta começa em zero.`;
      const apiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, temperature: 0.9, response_format: { type: 'json_object' }, messages: [ { role: 'system', content: 'Você cria quizzes educativos e verifica a consistência das respostas. Retorne somente o JSON solicitado.' }, { role: 'user', content: prompt } ] })
      });
      if (!apiRes.ok) { const err = await apiRes.text(); console.error('OpenAI API error:', apiRes.status, err.slice(0, 500)); send(res, 502, { error: 'A IA não conseguiu gerar as perguntas agora. Tente novamente mais tarde.' }); return; }
      const result = await apiRes.json();
      let parsed;
      try { parsed = JSON.parse(result.choices?.[0]?.message?.content || '{}'); } catch { parsed = {}; }
      const questions = cleanQuestions(parsed.questions, category);
      if (questions.length < 5) { send(res, 502, { error: 'A IA retornou poucas perguntas válidas. Tente novamente.' }); return; }
      send(res, 200, { questions });
    } catch (err) { console.error(err); send(res, 400, { error: 'Não foi possível processar o pedido.' }); }
    return;
  }
  send(res, 404, { error: 'Página não encontrada.' });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Desafio Premiado rodando na porta ${PORT}`));
