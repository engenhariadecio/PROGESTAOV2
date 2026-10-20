const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

/*
 * Contador por câmera (celular na linha) + painel ao vivo.
 *
 * O celular manda um quadro JPEG a cada ~0,7 s e o servidor guarda só o último
 * de cada célula, em memória — nada de vídeo no banco. Quem abre o painel
 * busca esse quadro repetidamente e vê a linha "ao vivo" com ~1 s de atraso.
 * Os eventos de contagem (com miniatura) vão para o banco.
 */

const QUADROS = new Map();   // celula -> { buf, ts, sessao_id, contagem, estado, dispositivo }
const QUADRO_MAX = 400 * 1024;
const FOTO_MAX = 200 * 1024;
const VIVO_MS = 8000;        // sem quadro há mais que isso = linha offline

const b64jpeg = (s) => {
  const m = /^data:image\/jpeg;base64,(.+)$/s.exec(s || '');
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  return buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 ? buf : null;
};
/* Datas e horas sempre no fuso do Node (TZ=America/Sao_Paulo em produção) —
   o Postgres da nuvem fica em UTC, então nada de LOCALTIME/CURRENT_DATE aqui. */
const FUSO = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo';
const pad = n => String(n).padStart(2, '0');
const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const agoraHMS = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const diaLocal = (col, idx) => `(${col} AT TIME ZONE '${FUSO}')::date = $${idx}::date`;
const dataOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/* ───────── Ao vivo ───────── */

router.post('/frame', requireAuth, (req, res) => {
  const { celula, sessao_id, contagem, estado, dispositivo, jpeg } = req.body || {};
  if (!celula) return res.status(400).json({ error: 'Célula obrigatória' });
  const buf = b64jpeg(jpeg);
  if (!buf) return res.status(400).json({ error: 'Quadro inválido' });
  if (buf.length > QUADRO_MAX) return res.status(413).json({ error: 'Quadro muito grande' });
  QUADROS.set(String(celula), {
    buf, ts: Date.now(), sessao_id: sessao_id || null, contagem: Number(contagem) || 0,
    estado: String(estado || '').slice(0, 40), dispositivo: String(dispositivo || '').slice(0, 120),
    usuario: req.session.nome || req.session.username
  });
  res.json({ ok: true });
});

router.get('/frame/:celula', requireAuth, (req, res) => {
  const q = QUADROS.get(req.params.celula);
  if (!q) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Frame-Ts': String(q.ts) });
  res.send(q.buf);
});

/* Linhas ativas agora + contagem do dia de cada uma */
router.get('/linhas', requireAuth, async (req, res) => {
  try {
    const data = dataOk(req.query.data) ? req.query.data : hoje();
    const agora = Date.now();
    const contagens = (await pool.query(
      `SELECT celula, sessao_id, SUM(valor)::int AS contagem, MAX(ts) AS ultimo
         FROM cont_eventos WHERE ${diaLocal('ts', 1)} GROUP BY celula, sessao_id`, [data])).rows;
    const linhas = [];
    for (const [celula, q] of QUADROS) {
      const c = contagens.find(x => x.celula === celula && String(x.sessao_id) === String(q.sessao_id)) || {};
      linhas.push({ celula, online: agora - q.ts < VIVO_MS, frame_ts: q.ts, sessao_id: q.sessao_id,
        contagem: c.contagem != null ? c.contagem : q.contagem, estado: q.estado, dispositivo: q.dispositivo, usuario: q.usuario, ultimo: c.ultimo || null });
    }
    // células com eventos hoje mas sem celular ligado agora
    contagens.forEach(c => { if (!linhas.some(l => l.celula === c.celula)) linhas.push({ celula: c.celula, online: false, frame_ts: null, sessao_id: c.sessao_id, contagem: c.contagem, estado: '', ultimo: c.ultimo }); });
    // dados da sessão do cadenciador (takt, ciclos previstos até agora)
    for (const l of linhas) {
      if (!l.sessao_id) continue;
      const s = (await pool.query(
        `SELECT s.id, s.takt_min::float AS takt_min, s.status, p.nome AS produto_nome, t.nome AS turno_nome, t.codigo AS turno_codigo,
                (SELECT COUNT(*)::int FROM cad_ciclos c WHERE c.sessao_id = s.id) AS total_ciclos,
                (SELECT COUNT(*)::int FROM cad_ciclos c WHERE c.sessao_id = s.id AND c.hora_prevista <= $2::time) AS ciclos_ate_agora
           FROM cad_sessoes s JOIN cad_produtos p ON p.id = s.produto_id JOIN turnos t ON t.id = s.turno_id WHERE s.id = $1`, [l.sessao_id, agoraHMS()])).rows[0];
      if (s) Object.assign(l, { takt_min: s.takt_min, produto_nome: s.produto_nome, turno_nome: s.turno_nome, total_ciclos: s.total_ciclos, esperado: s.ciclos_ate_agora, sessao_status: s.status });
    }
    linhas.sort((a, b) => a.celula.localeCompare(b.celula));
    res.json(linhas);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ───────── Eventos ───────── */

router.post('/eventos', requireAuth, async (req, res) => {
  try {
    const { celula, sessao_id, origem, ts, foto, mudanca_pct, dispositivo } = req.body || {};
    if (!celula) return res.status(400).json({ error: 'Célula obrigatória' });
    const ORIG = { ia: 1, manual_mais: 1, manual_menos: -1, troca_pallet: 0, estorno: -1 };   // estorno: a própria câmera desfez uma contagem (pessoa parada, não produto)
    if (!(origem in ORIG)) return res.status(400).json({ error: 'Origem inválida' });
    let fotoBuf = b64jpeg(foto);
    if (fotoBuf && fotoBuf.length > FOTO_MAX) fotoBuf = null;
    const quando = ts && !isNaN(Date.parse(ts)) ? new Date(ts) : new Date();
    const r = await pool.query(
      `INSERT INTO cont_eventos (celula, sessao_id, ts, origem, valor, mudanca_pct, foto, dispositivo, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, ts`,
      [String(celula).slice(0, 80), /^\d+$/.test(String(sessao_id || '')) ? Number(sessao_id) : null, quando, origem, ORIG[origem],
       mudanca_pct != null && isFinite(Number(mudanca_pct)) ? Number(mudanca_pct) : null, fotoBuf,
       String(dispositivo || '').slice(0, 120), req.session.userId || null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/eventos', requireAuth, async (req, res) => {
  try {
    const where = [], params = [];
    if (dataOk(req.query.data)) { params.push(req.query.data); where.push(diaLocal('e.ts', params.length)); }
    if (req.query.celula) { params.push(req.query.celula); where.push(`e.celula = $${params.length}`); }
    if (/^\d+$/.test(String(req.query.sessao_id || ''))) { params.push(Number(req.query.sessao_id)); where.push(`e.sessao_id = $${params.length}`); }
    const r = await pool.query(
      `SELECT e.id, e.celula, e.sessao_id, e.ts, e.origem, e.valor, e.mudanca_pct, (e.foto IS NOT NULL) AS tem_foto, e.dispositivo, u.nome AS usuario_nome
         FROM cont_eventos e LEFT JOIN users u ON u.id = e.usuario_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.ts, e.id`, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/eventos/:id/foto', requireAuth, async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).end();
    const r = await pool.query('SELECT foto FROM cont_eventos WHERE id=$1', [req.params.id]);
    if (!r.rows.length || !r.rows[0].foto) return res.status(404).end();
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.send(r.rows[0].foto);
  } catch (e) { res.status(500).end(); }
});

router.delete('/eventos/:id', requireAuth, async (req, res) => {
  try {
    if (req.session.role === 'pcp') return res.status(403).json({ error: 'Somente visualização' });
    await pool.query('DELETE FROM cont_eventos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ───────── Análise de uma sessão/célula/dia ─────────
   Devolve os ciclos previstos (cadenciador) e os eventos reais, para o painel
   montar esperado × real, intervalo entre saídas × takt, etc. */
router.get('/analise', requireAuth, async (req, res) => {
  try {
    const data = dataOk(req.query.data) ? req.query.data : hoje();
    const celula = req.query.celula || null;
    const sessaoId = /^\d+$/.test(String(req.query.sessao_id || '')) ? Number(req.query.sessao_id) : null;
    const params = [data]; let where = diaLocal('e.ts', 1);
    if (celula) { params.push(celula); where += ` AND e.celula = $${params.length}`; }
    if (sessaoId) { params.push(sessaoId); where += ` AND e.sessao_id = $${params.length}`; }
    const eventos = (await pool.query(
      `SELECT e.id, e.celula, e.sessao_id, e.ts, e.origem, e.valor, e.mudanca_pct, (e.foto IS NOT NULL) AS tem_foto
         FROM cont_eventos e WHERE ${where} ORDER BY e.ts, e.id`, params)).rows;
    let sessao = null, ciclos = [], paradas = [];
    const sid = sessaoId || (eventos.find(e => e.sessao_id) || {}).sessao_id;
    if (sid) {
      sessao = (await pool.query(
        `SELECT s.id, s.data, s.takt_min::float AS takt_min, s.status, s.tempo_parado_seg, p.nome AS produto_nome, t.nome AS turno_nome,
                t.hora_inicio, t.hora_fim FROM cad_sessoes s JOIN cad_produtos p ON p.id = s.produto_id JOIN turnos t ON t.id = s.turno_id WHERE s.id = $1`, [sid])).rows[0] || null;
      ciclos = (await pool.query('SELECT numero, hora_prevista, concluido FROM cad_ciclos WHERE sessao_id=$1 ORDER BY numero', [sid])).rows;
      paradas = (await pool.query('SELECT inicio, fim, duracao_seg, motivo FROM cad_paradas WHERE sessao_id=$1 ORDER BY inicio', [sid])).rows;
    }
    res.json({ data, celula, sessao, ciclos, paradas, eventos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Dias/células com contagem (para o histórico) */
router.get('/historico', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT to_char((e.ts AT TIME ZONE '${FUSO}')::date, 'YYYY-MM-DD') AS data, e.celula, e.sessao_id, SUM(e.valor)::int AS contagem,
              COUNT(*) FILTER (WHERE e.origem='ia')::int AS ia, COUNT(*) FILTER (WHERE e.origem='manual_mais')::int AS mais,
              COUNT(*) FILTER (WHERE e.origem='manual_menos')::int AS menos, COUNT(*) FILTER (WHERE e.origem='estorno')::int AS estornos, MIN(e.ts) AS primeiro, MAX(e.ts) AS ultimo,
              s.takt_min::float AS takt_min, p.nome AS produto_nome, t.nome AS turno_nome,
              (SELECT COUNT(*)::int FROM cad_ciclos c WHERE c.sessao_id = s.id) AS total_ciclos
         FROM cont_eventos e LEFT JOIN cad_sessoes s ON s.id = e.sessao_id
         LEFT JOIN cad_produtos p ON p.id = s.produto_id LEFT JOIN turnos t ON t.id = s.turno_id
        GROUP BY (e.ts AT TIME ZONE '${FUSO}')::date, e.celula, e.sessao_id, s.id, s.takt_min, p.nome, t.nome
        ORDER BY (e.ts AT TIME ZONE '${FUSO}')::date DESC, e.celula`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
