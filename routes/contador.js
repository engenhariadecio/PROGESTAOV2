const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

/*
 * Contador por câmera.
 *
 * Linha = célula + produto do cadenciador (tabela cont_linhas), criada no PC.
 * O celular abre o link da linha, conecta a câmera e passa a:
 *   - mandar um quadro JPEG a cada ~0,7 s (só o último fica em memória: ao vivo);
 *   - buscar a configuração e os comandos a cada ~1,5 s (área do pallet, caixa,
 *     câmera, zoom, sensibilidade; recalibrar, +1/−1, troca de pallet...).
 * Assim quem está no PC vê a imagem e configura a câmera de longe.
 * Os eventos de contagem (com miniatura de evidência) vão para o banco.
 */

const QUADROS = new Map();    // linha_id -> { buf, ts, contagem, estado, dispositivo, usuario, capacidades }
const COMANDOS = new Map();   // linha_id -> [{ tipo, valor, ts }]
const QUADRO_MAX = 400 * 1024;
const FOTO_MAX = 200 * 1024;
const VIVO_MS = 8000;

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
const idOk = v => /^\d+$/.test(String(v || ''));
const naoPcp = (req, res, next) => req.session.role === 'pcp' ? res.status(403).json({ error: 'Perfil PCP: somente visualização' }) : next();

/* ───────── Config da linha ───────── */
const CONFIG_PADRAO = { zona: null, caixa: null, sens: 5, camera: '', zoom: null, lanterna: false, resolucao: 'media', multiplas: false };
const ret = o => o && typeof o === 'object' && ['x', 'y', 'w', 'h'].every(k => isFinite(Number(o[k]))) ? { x: +o.x, y: +o.y, w: +o.w, h: +o.h } : null;
function limparConfig(c) {
  c = c || {};
  const out = {};
  if ('zona' in c) out.zona = ret(c.zona);
  if ('caixa_pos' in c) out.caixa_pos = c.caixa_pos && isFinite(Number(c.caixa_pos.x)) ? { x: +c.caixa_pos.x, y: +c.caixa_pos.y } : null;
  if ('caixa' in c) out.caixa = c.caixa && isFinite(Number(c.caixa.w)) && isFinite(Number(c.caixa.h)) ? { w: +c.caixa.w, h: +c.caixa.h } : null;
  if ('sens' in c) out.sens = Math.min(10, Math.max(1, Number(c.sens) || 5));
  if ('camera' in c) out.camera = String(c.camera || '').slice(0, 200);
  if ('zoom' in c) out.zoom = c.zoom == null || c.zoom === '' ? null : Number(c.zoom);
  if ('lanterna' in c) out.lanterna = !!c.lanterna;
  if ('resolucao' in c) out.resolucao = ['baixa', 'media', 'alta'].includes(c.resolucao) ? c.resolucao : 'media';
  if ('multiplas' in c) out.multiplas = !!c.multiplas;
  return out;
}

const SQL_LINHA = `
  SELECT l.id, l.celula, l.produto_id, l.nome, l.config, l.ativa, l.updated_at,
         p.nome AS produto_nome, p.cod_decio, p.takt_min::float AS takt_padrao, p.celula_id AS produto_celula_id
    FROM cont_linhas l LEFT JOIN cad_produtos p ON p.id = l.produto_id`;

async function carregarLinha(id) {
  const r = await pool.query(SQL_LINHA + ' WHERE l.id = $1', [id]);
  if (!r.rows[0]) return null;
  const l = r.rows[0]; l.config = { ...CONFIG_PADRAO, ...(l.config || {}) };
  return l;
}
/* Sessão do cadenciador de hoje para o produto da linha (prefere a aberta) */
async function sessaoDeHoje(produtoId) {
  if (!produtoId) return null;
  const r = await pool.query(
    `SELECT s.id, s.takt_min::float AS takt_min, s.status, t.nome AS turno_nome, t.codigo AS turno_codigo,
            (SELECT COUNT(*)::int FROM cad_ciclos c WHERE c.sessao_id = s.id) AS total_ciclos,
            (SELECT COUNT(*)::int FROM cad_ciclos c WHERE c.sessao_id = s.id AND c.hora_prevista <= $3::time) AS esperado
       FROM cad_sessoes s JOIN turnos t ON t.id = s.turno_id
      WHERE s.produto_id = $1 AND s.data = $2
      ORDER BY (s.status = 'aberta') DESC, s.id DESC LIMIT 1`, [produtoId, hoje(), agoraHMS()]);
  return r.rows[0] || null;
}

/* ───────── Linhas (CRUD — PC) ───────── */

router.get('/linhas', requireAuth, async (req, res) => {
  try {
    const data = dataOk(req.query.data) ? req.query.data : hoje();
    const linhas = (await pool.query(SQL_LINHA + ' WHERE l.ativa ORDER BY l.celula')).rows;
    const contagens = (await pool.query(
      `SELECT linha_id, SUM(valor)::int AS contagem, MAX(ts) AS ultimo FROM cont_eventos WHERE ${diaLocal('ts', 1)} GROUP BY linha_id`, [data])).rows;
    const agora = Date.now();
    for (const l of linhas) {
      l.config = { ...CONFIG_PADRAO, ...(l.config || {}) };
      const q = QUADROS.get(l.id);
      const c = contagens.find(x => x.linha_id === l.id) || {};
      l.online = !!q && agora - q.ts < VIVO_MS;
      l.frame_ts = q ? q.ts : null;
      l.estado = q ? q.estado : '';
      l.dispositivo = q ? q.dispositivo : null;
      l.usuario = q ? q.usuario : null;
      l.capacidades = q ? q.capacidades : null;
      l.contagem = c.contagem || 0;
      l.ultimo = c.ultimo || null;
      l.sessao = await sessaoDeHoje(l.produto_id);
    }
    res.json(linhas);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/linhas', requireAdmin, async (req, res) => {
  try {
    const { celula, produto_id, nome } = req.body || {};
    if (!celula || !String(celula).trim()) return res.status(400).json({ error: 'Célula obrigatória' });
    const r = await pool.query(
      `INSERT INTO cont_linhas (celula, produto_id, nome) VALUES ($1, $2, $3)
       ON CONFLICT (celula) DO UPDATE SET produto_id = EXCLUDED.produto_id, nome = EXCLUDED.nome, ativa = TRUE, updated_at = NOW()
       RETURNING id`,
      [String(celula).trim().slice(0, 80), idOk(produto_id) ? Number(produto_id) : null, nome ? String(nome).slice(0, 120) : null]);
    res.json(await carregarLinha(r.rows[0].id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/linhas/:id', requireAdmin, async (req, res) => {
  try {
    if (!idOk(req.params.id)) return res.status(400).end();
    const { celula, produto_id, nome, ativa } = req.body || {};
    const set = ['updated_at = NOW()'], params = [req.params.id];
    if (celula) { params.push(String(celula).trim().slice(0, 80)); set.push(`celula = $${params.length}`); }
    if (produto_id !== undefined) { params.push(idOk(produto_id) ? Number(produto_id) : null); set.push(`produto_id = $${params.length}`); }
    if (nome !== undefined) { params.push(nome ? String(nome).slice(0, 120) : null); set.push(`nome = $${params.length}`); }
    if (typeof ativa === 'boolean') { params.push(ativa); set.push(`ativa = $${params.length}`); }
    await pool.query(`UPDATE cont_linhas SET ${set.join(', ')} WHERE id = $1`, params);
    res.json(await carregarLinha(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/linhas/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE cont_linhas SET ativa = FALSE, updated_at = NOW() WHERE id = $1', [req.params.id]);
    QUADROS.delete(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Configuração da câmera/área — feita do PC (ou do próprio celular) */
router.put('/linhas/:id/config', requireAuth, naoPcp, async (req, res) => {
  try {
    if (!idOk(req.params.id)) return res.status(400).end();
    const novo = limparConfig(req.body);
    const r = await pool.query(
      `UPDATE cont_linhas SET config = config || $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING config, updated_at`,
      [req.params.id, JSON.stringify(novo)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Linha não encontrada' });
    res.json({ config: { ...CONFIG_PADRAO, ...r.rows[0].config }, updated_at: r.rows[0].updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Comando remoto para o celular: recalibrar | troca_pallet | mais | menos | reiniciar_camera */
const TIPOS_CMD = ['recalibrar', 'troca_pallet', 'mais', 'menos', 'reiniciar_camera', 'encerrar'];
router.post('/linhas/:id/comando', requireAuth, naoPcp, (req, res) => {
  const { tipo } = req.body || {};
  if (!TIPOS_CMD.includes(tipo)) return res.status(400).json({ error: 'Comando inválido' });
  const id = Number(req.params.id);
  const fila = COMANDOS.get(id) || [];
  fila.push({ tipo, ts: Date.now(), por: req.session.nome || req.session.username });
  COMANDOS.set(id, fila.slice(-20));
  res.json({ ok: true });
});

/* O celular pergunta: config atual + sessão do cadenciador + comandos pendentes */
router.get('/linhas/:id/estado', requireAuth, async (req, res) => {
  try {
    const l = await carregarLinha(req.params.id);
    if (!l || !l.ativa) return res.status(404).json({ error: 'Linha não encontrada' });
    const comandos = COMANDOS.get(l.id) || [];
    COMANDOS.set(l.id, []);
    const data = hoje();
    const cont = (await pool.query(`SELECT COALESCE(SUM(valor), 0)::int AS c FROM cont_eventos WHERE linha_id = $1 AND ${diaLocal('ts', 2)}`, [l.id, data])).rows[0].c;
    res.json({ linha: { id: l.id, celula: l.celula, nome: l.nome, produto_id: l.produto_id, produto_nome: l.produto_nome, takt_padrao: l.takt_padrao },
      config: l.config, config_ts: l.updated_at, sessao: await sessaoDeHoje(l.produto_id), contagem: cont, comandos, agora: Date.now() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/linhas/:id/qr.svg', requireAuth, async (req, res) => {
  try {
    const origem = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`;
    const svg = await QRCode.toString(`${origem}/contador?linha=${Number(req.params.id)}`, { type: 'svg', margin: 1, width: 240 });
    res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=3600' }).send(svg);
  } catch (e) { res.status(500).end(); }
});

/* ───────── Ao vivo ───────── */

router.post('/frame', requireAuth, (req, res) => {
  const { linha_id, contagem, estado, dispositivo, jpeg, capacidades } = req.body || {};
  if (!idOk(linha_id)) return res.status(400).json({ error: 'Linha obrigatória' });
  const buf = b64jpeg(jpeg);
  if (!buf) return res.status(400).json({ error: 'Quadro inválido' });
  if (buf.length > QUADRO_MAX) return res.status(413).json({ error: 'Quadro muito grande' });
  const id = Number(linha_id);
  const ant = QUADROS.get(id) || {};
  QUADROS.set(id, {
    buf, ts: Date.now(), contagem: Number(contagem) || 0,
    estado: String(estado || '').slice(0, 40), dispositivo: String(dispositivo || '').slice(0, 120),
    usuario: req.session.nome || req.session.username,
    capacidades: capacidades && typeof capacidades === 'object' ? capacidades : (ant.capacidades || null)
  });
  res.json({ ok: true, comandos: (COMANDOS.get(id) || []).length });
});

router.get('/frame/:linha', requireAuth, (req, res) => {
  const q = QUADROS.get(Number(req.params.linha));
  if (!q) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Frame-Ts': String(q.ts) });
  res.send(q.buf);
});

/* ───────── Eventos ───────── */

const ORIG = { ia: 1, manual_mais: 1, manual_menos: -1, troca_pallet: 0, estorno: -1 };   // estorno: a própria câmera desfez uma contagem

router.post('/eventos', requireAuth, naoPcp, async (req, res) => {
  try {
    const { linha_id, celula, sessao_id, origem, valor, ts, foto, mudanca_pct, dispositivo } = req.body || {};
    if (!(origem in ORIG)) return res.status(400).json({ error: 'Origem inválida' });
    let linha = null;
    if (idOk(linha_id)) linha = await carregarLinha(linha_id);
    const cel = linha ? linha.celula : String(celula || '').trim();
    if (!cel) return res.status(400).json({ error: 'Célula obrigatória' });
    let sid = idOk(sessao_id) ? Number(sessao_id) : null;
    if (!sid && linha) { const s = await sessaoDeHoje(linha.produto_id); sid = s ? s.id : null; }
    let v = ORIG[origem];
    if (origem === 'ia' && idOk(valor)) v = Math.min(4, Math.max(1, Number(valor)));   // várias caixas de uma vez (opcional)
    let fotoBuf = b64jpeg(foto);
    if (fotoBuf && fotoBuf.length > FOTO_MAX) fotoBuf = null;
    const quando = ts && !isNaN(Date.parse(ts)) ? new Date(ts) : new Date();
    const r = await pool.query(
      `INSERT INTO cont_eventos (linha_id, celula, sessao_id, ts, origem, valor, mudanca_pct, foto, dispositivo, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, ts, valor`,
      [linha ? linha.id : null, cel.slice(0, 80), sid, quando, origem, v,
       mudanca_pct != null && isFinite(Number(mudanca_pct)) ? Number(mudanca_pct) : null, fotoBuf,
       String(dispositivo || '').slice(0, 120), req.session.userId || null]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function filtroEventos(q, params, where) {
  if (dataOk(q.data)) { params.push(q.data); where.push(diaLocal('e.ts', params.length)); }
  if (idOk(q.linha_id)) { params.push(Number(q.linha_id)); where.push(`e.linha_id = $${params.length}`); }
  if (q.celula) { params.push(q.celula); where.push(`e.celula = $${params.length}`); }
  if (idOk(q.sessao_id)) { params.push(Number(q.sessao_id)); where.push(`e.sessao_id = $${params.length}`); }
}

router.get('/eventos', requireAuth, async (req, res) => {
  try {
    const where = [], params = [];
    filtroEventos(req.query, params, where);
    const r = await pool.query(
      `SELECT e.id, e.linha_id, e.celula, e.sessao_id, e.ts, e.origem, e.valor, e.mudanca_pct, (e.foto IS NOT NULL) AS tem_foto, e.dispositivo, u.nome AS usuario_nome
         FROM cont_eventos e LEFT JOIN users u ON u.id = e.usuario_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.ts, e.id`, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/eventos/:id/foto', requireAuth, async (req, res) => {
  try {
    if (!idOk(req.params.id)) return res.status(400).end();
    const r = await pool.query('SELECT foto FROM cont_eventos WHERE id=$1', [req.params.id]);
    if (!r.rows.length || !r.rows[0].foto) return res.status(404).end();
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.send(r.rows[0].foto);
  } catch (e) { res.status(500).end(); }
});

router.delete('/eventos/:id', requireAuth, naoPcp, async (req, res) => {
  try {
    await pool.query('DELETE FROM cont_eventos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ───────── Análise de um dia/linha ─────────
   Ciclos previstos (cadenciador) + eventos reais, para o painel montar
   esperado × real, intervalo entre saídas × takt, etc. */
router.get('/analise', requireAuth, async (req, res) => {
  try {
    const data = dataOk(req.query.data) ? req.query.data : hoje();
    const where = [], params = [];
    filtroEventos({ ...req.query, data }, params, where);
    const eventos = (await pool.query(
      `SELECT e.id, e.linha_id, e.celula, e.sessao_id, e.ts, e.origem, e.valor, e.mudanca_pct, (e.foto IS NOT NULL) AS tem_foto
         FROM cont_eventos e WHERE ${where.join(' AND ')} ORDER BY e.ts, e.id`, params)).rows;
    let sessao = null, ciclos = [], paradas = [];
    let sid = idOk(req.query.sessao_id) ? Number(req.query.sessao_id) : (eventos.find(e => e.sessao_id) || {}).sessao_id;
    if (!sid && idOk(req.query.linha_id) && data === hoje()) { const l = await carregarLinha(req.query.linha_id); const s = l && await sessaoDeHoje(l.produto_id); sid = s ? s.id : null; }
    if (sid) {
      sessao = (await pool.query(
        `SELECT s.id, s.data, s.takt_min::float AS takt_min, s.status, s.tempo_parado_seg, p.nome AS produto_nome, t.nome AS turno_nome,
                t.hora_inicio, t.hora_fim FROM cad_sessoes s JOIN cad_produtos p ON p.id = s.produto_id JOIN turnos t ON t.id = s.turno_id WHERE s.id = $1`, [sid])).rows[0] || null;
      ciclos = (await pool.query('SELECT numero, hora_prevista, concluido FROM cad_ciclos WHERE sessao_id=$1 ORDER BY numero', [sid])).rows;
      paradas = (await pool.query('SELECT inicio, fim, duracao_seg, motivo FROM cad_paradas WHERE sessao_id=$1 ORDER BY inicio', [sid])).rows;
    }
    res.json({ data, sessao, ciclos, paradas, eventos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Dias/linhas com contagem (histórico) */
router.get('/historico', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT to_char((e.ts AT TIME ZONE '${FUSO}')::date, 'YYYY-MM-DD') AS data, e.linha_id, e.celula, e.sessao_id, SUM(e.valor)::int AS contagem,
              COUNT(*) FILTER (WHERE e.origem='ia')::int AS ia, COUNT(*) FILTER (WHERE e.origem='manual_mais')::int AS mais,
              COUNT(*) FILTER (WHERE e.origem='manual_menos')::int AS menos, COUNT(*) FILTER (WHERE e.origem='estorno')::int AS estornos,
              MIN(e.ts) AS primeiro, MAX(e.ts) AS ultimo,
              s.takt_min::float AS takt_min, p.nome AS produto_nome, t.nome AS turno_nome,
              (SELECT COUNT(*)::int FROM cad_ciclos c WHERE c.sessao_id = s.id) AS total_ciclos
         FROM cont_eventos e LEFT JOIN cad_sessoes s ON s.id = e.sessao_id
         LEFT JOIN cad_produtos p ON p.id = s.produto_id LEFT JOIN turnos t ON t.id = s.turno_id
        GROUP BY (e.ts AT TIME ZONE '${FUSO}')::date, e.linha_id, e.celula, e.sessao_id, s.id, s.takt_min, p.nome, t.nome
        ORDER BY (e.ts AT TIME ZONE '${FUSO}')::date DESC, e.celula`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
