/* ═══════════════════════════════════════════════════════════════
   CONTADOR POR CÂMERA — motor compartilhado (tablet do cadenciador
   e celular avulso usam este mesmo código).

   ─ Cada caixa colocada no pallet muda uma parte da área marcada
     (onde antes era fundo/madeira, agora é caixa).
   ─ A IA (MediaPipe Pose, no próprio aparelho) detecta a pessoa. Enquanto
     há pessoa/movimento sobre a área, esperamos.
   ─ Área livre e parada por ~3 s → compara com a referência: mudou pelo
     menos uma fração de caixa → +1 (nova referência, foto de evidência);
     mudou "muitas caixas" → troca de pallet; não mudou → nada.
   ─ A configuração vem do servidor (linha + produto) e é reaplicada
     quando muda; comandos remotos chegam pelo mesmo canal.

   Uso:
     const cam = ContadorCam.criar({ video, canvas, flash, hud: { ia, estado, live },
                                     onContagem(n), onEvento(ev), onEstado(txt), onConfig(cfg) });
     await cam.conectar({ linhaId, produtoId, sessaoId });
     cam.registrar('manual_mais') … cam.parar()
   Requer core.js (API, avisoOk/avisoErro) e, se disponível, pose.js.
   ═══════════════════════════════════════════════════════════════ */
window.ContadorCam = (function () {
  const PROC_W = 320, PROC_H = 240, REF_W = 96, REF_H = 72, ENVIO_MS = 700, POLL_MS = 1500;
  const RES = { baixa: { w: 640, h: 480 }, media: { w: 1280, h: 960 }, alta: { w: 1920, h: 1440 } };
  const CFG_PADRAO = { zona: null, caixa: null, sens: 5, camera: '', zoom: null, lanterna: false, resolucao: 'media', multiplas: false };
  const disp = (navigator.userAgent.match(/\((.*?)\)/) || [])[1] || 'aparelho';

  function criar(o) {
    const video = o.video, sobre = o.canvas, sctx = sobre ? sobre.getContext('2d') : null;
    const proc = document.createElement('canvas'); proc.width = PROC_W; proc.height = PROC_H;
    const pctx = proc.getContext('2d', { willReadFrequently: true });
    const envio = document.createElement('canvas'); envio.width = 480; envio.height = 360;
    const ectx = envio.getContext('2d');

    const S = {   // estado interno
      linha: null, linhaId: null, produtoId: null, sessaoId: null, sessao: null, stream: null, pose: null,
      cfg: { ...CFG_PADRAO }, cfgTs: null, zona: null, ref: null, refAnterior: null,
      estado: 'calibrando', livreDesde: 0, confirmandoDesde: 0, ultimaContagemTs: 0, ultimoQuadro: null, pessoaBox: null,
      contagem: 0, eventos: [], fila: [], pausado: false, ultimoEnvio: 0, ultimoPose: 0, posePronto: false, poseOcupado: false, iaOk: false,
      capacidades: null, capEnviadas: false, zonaEditadaLocal: false, desenhando: null, ativo: false, timers: [], fps: 0, fpsT: 0, fpsN: 0, raf: 0,
      tamanhos: [], fundo: null, caixaCor: null
    };
    try { S.fila = JSON.parse(localStorage.getItem('contador.fila') || '[]'); } catch (_) {}
    const hud = (k, txt, cls) => { const el = o.hud && o.hud[k]; if (!el) return; if (txt != null) el.textContent = txt; if (cls != null) el.className = 'selo-hud ' + cls; };

    /* ───────── câmera ───────── */
    async function abrirCamera() {
      if (S.stream) S.stream.getTracks().forEach(t => t.stop());
      const r = RES[S.cfg.resolucao] || RES.media, base = { width: { ideal: r.w }, height: { ideal: r.h } };
      const tentativas = [];
      if (S.cfg.camera) tentativas.push({ deviceId: { exact: S.cfg.camera }, ...base });
      tentativas.push({ facingMode: { ideal: 'environment' }, ...base }, { ...base }, true);
      let erro = null;
      for (const v of tentativas) { try { S.stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false }); erro = null; break; } catch (e) { erro = e; } }
      if (erro) throw erro;
      video.srcObject = S.stream; await video.play().catch(() => {});
      S.ref = null; S.estado = 'calibrando'; S.livreDesde = 0;
      await lerCapacidades(); aplicarAjustesCamera();
    }
    async function lerCapacidades() {
      const track = S.stream && S.stream.getVideoTracks()[0];
      const caps = track && track.getCapabilities ? track.getCapabilities() : {};
      const st = track && track.getSettings ? track.getSettings() : {};
      let cameras = [];
      try { cameras = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || 'Câmera ' + (i + 1) })); } catch (_) {}
      S.capacidades = { cameras, camera_atual: st.deviceId || '', zoom: caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1, atual: st.zoom } : null,
        lanterna: !!caps.torch, largura: st.width, altura: st.height, ia: S.iaOk };
      S.capEnviadas = false;
    }
    async function aplicarAjustesCamera() {
      const track = S.stream && S.stream.getVideoTracks()[0]; if (!track || !track.applyConstraints) return;
      const adv = [];
      if (S.capacidades && S.capacidades.zoom && S.cfg.zoom != null) adv.push({ zoom: Math.min(S.capacidades.zoom.max, Math.max(S.capacidades.zoom.min, Number(S.cfg.zoom))) });
      if (S.capacidades && S.capacidades.lanterna) adv.push({ torch: !!S.cfg.lanterna });
      if (adv.length) { try { await track.applyConstraints({ advanced: adv }); } catch (e) { console.warn('ajuste câmera', e); } }
    }
    function iniciarPose() {
      if (typeof Pose === 'undefined') { hud('ia', 'IA indisponível — usando só movimento', 'alerta'); return; }
      try {
        S.pose = new Pose({ locateFile: f => '/js/mediapipe/pose/' + f });
        S.pose.setOptions({ modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
        S.pose.onResults(r => {
          S.iaOk = true; hud('ia', 'IA: pessoa ' + (r.poseLandmarks ? 'detectada' : 'não'), r.poseLandmarks ? 'on' : '');
          if (!r.poseLandmarks) { S.pessoaBox = null; return; }
          const vis = r.poseLandmarks.filter(l => (l.visibility || 0) > 0.5);
          if (vis.length < 4) { S.pessoaBox = null; return; }
          const xs = vis.map(l => l.x), ys = vis.map(l => l.y);
          S.pessoaBox = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        });
        S.pose.initialize().then(() => { S.posePronto = true; S.iaOk = true; if (S.capacidades) S.capacidades.ia = true; S.capEnviadas = false; hud('ia', 'IA: pronta', ''); })
          .catch(e => { console.warn('Pose', e); hud('ia', 'IA indisponível — usando só movimento', 'alerta'); S.pose = null; });
      } catch (e) { hud('ia', 'IA indisponível — usando só movimento', 'alerta'); S.pose = null; }
    }

    /* ───────── servidor: config + comandos ───────── */
    function urlEstado() { return `/api/contador/linhas/${S.linhaId}/estado?produto_id=${S.produtoId || ''}&sessao_id=${S.sessaoId || ''}`; }
    async function sincronizar(primeira) {
      const e = await API.get(urlEstado());
      S.sessao = e.sessao; S.linha = { ...(S.linha || {}), ...e.linha };
      if (primeira || e.config_ts !== S.cfgTs) { S.cfgTs = e.config_ts; aplicarConfig(e.config, primeira); }
      if (!primeira && e.contagem !== S.contagem && !S.fila.length) { S.contagem = e.contagem; o.onContagem && o.onContagem(S.contagem); }
      for (const c of e.comandos || []) executarComando(c);
      o.onSessao && o.onSessao(S.sessao, S.contagem, S.eventos);
    }
    function aplicarConfig(novo, primeira) {
      const ant = S.cfg; S.cfg = { ...S.cfg, ...novo };
      const zonaMudou = JSON.stringify(S.cfg.zona) !== JSON.stringify(S.zona);
      if (zonaMudou && !S.zonaEditadaLocal) { S.zona = S.cfg.zona ? { ...S.cfg.zona } : null; S.ref = null; S.estado = 'calibrando'; S.livreDesde = 0; }
      S.zonaEditadaLocal = false;
      if (!primeira && S.stream) {
        if (S.cfg.camera !== ant.camera || S.cfg.resolucao !== ant.resolucao) abrirCamera().catch(e => avisoErro('Câmera: ' + e.message));
        else if (S.cfg.zoom !== ant.zoom || S.cfg.lanterna !== ant.lanterna) aplicarAjustesCamera();
      }
      o.onConfig && o.onConfig(S.cfg, S.zona);
    }
    function executarComando(c) {
      if (c.tipo === 'recalibrar') { recalibrar(); avisoOk('Recalibrando (comando do painel)'); }
      else if (c.tipo === 'troca_pallet') { recalibrar(); registrar('troca_pallet', 0, null); }
      else if (c.tipo === 'mais') registrar('manual_mais', 1, null);
      else if (c.tipo === 'menos') { if (S.contagem > 0) registrar('manual_menos', -1, null); }
      else if (c.tipo === 'reiniciar_camera') abrirCamera().catch(e => avisoErro('Câmera: ' + e.message));
      else if (c.tipo === 'encerrar') { parar(); o.onEncerrar && o.onEncerrar(); }
    }
    function recalibrar() { S.ref = null; S.refAnterior = null; S.fundo = null; S.estado = 'calibrando'; S.livreDesde = 0; }

    /* ───────── análise da área ───────── */
    function zonaPx() { const z = S.zona; return { x: Math.round(z.x * PROC_W), y: Math.round(z.y * PROC_H), w: Math.max(8, Math.round(z.w * PROC_W)), h: Math.max(8, Math.round(z.h * PROC_H)) }; }
    const N = REF_W * REF_H;
    /* a área reduzida a REF_W×REF_H: cinza (g) para detectar mudança e cor média (rgb) para decidir colocada × retirada */
    function amostraZona() {
      const z = zonaPx(); const img = pctx.getImageData(z.x, z.y, z.w, z.h).data;
      const g = new Float32Array(N), rgb = new Float32Array(N * 3);
      for (let j = 0; j < REF_H; j++) for (let i = 0; i < REF_W; i++) {
        let r = 0, gg = 0, b = 0, n = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const px = Math.min(z.w - 1, Math.floor((i + dx * .5) * z.w / REF_W)), py = Math.min(z.h - 1, Math.floor((j + dy * .5) * z.h / REF_H));
          const k = (py * z.w + px) * 4; r += img[k]; gg += img[k + 1]; b += img[k + 2]; n++;
        }
        const c = j * REF_W + i; rgb[c * 3] = r / n; rgb[c * 3 + 1] = gg / n; rgb[c * 3 + 2] = b / n;
        g[c] = (r * 0.299 + gg * 0.587 + b * 0.114) / n;
      }
      return { g, rgb };
    }
    function comparar(a, b, lim) { let mud = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > lim) mud++; return { frac: mud / a.length }; }
    /* manchas de mudança entre a amostra atual e a referência: cada caixa colocada/retirada vira uma mancha compacta */
    function manchas(atual, ref, lim) {
      const m = new Uint8Array(N), m2 = new Uint8Array(N);
      // diferença por cor (maior desvio entre R, G e B): papelão sobre piso cinza tem o mesmo brilho, mas não a mesma cor
      for (let i = 0; i < N; i++) { const k = i * 3; const d = Math.max(Math.abs(atual.rgb[k] - ref.rgb[k]), Math.abs(atual.rgb[k + 1] - ref.rgb[k + 1]), Math.abs(atual.rgb[k + 2] - ref.rgb[k + 2])); m[i] = d > lim ? 1 : 0; }
      // limpeza: tira pontos isolados e fecha buracos pequenos
      for (let j = 0; j < REF_H; j++) for (let i = 0; i < REF_W; i++) {
        let v = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const x = i + dx, y = j + dy; if (x >= 0 && y >= 0 && x < REF_W && y < REF_H && m[y * REF_W + x]) v++; }
        const c = j * REF_W + i; m2[c] = m[c] ? (v >= 3 ? 1 : 0) : (v >= 6 ? 1 : 0);
      }
      // componentes conexos (4 vizinhos)
      const vis = new Uint8Array(N), lista = []; const fila = new Int32Array(N);
      let total = 0;
      for (let s = 0; s < N; s++) {
        if (!m2[s] || vis[s]) continue;
        let h = 0, q = 0; fila[q++] = s; vis[s] = 1;
        const cel = []; let x0 = REF_W, x1 = 0, y0 = REF_H, y1 = 0;
        while (h < q) {
          const c = fila[h++]; cel.push(c); const x = c % REF_W, y = (c / REF_W) | 0;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          const viz = [c - 1, c + 1, c - REF_W, c + REF_W];
          if (x === 0) viz[0] = -1; if (x === REF_W - 1) viz[1] = -1;
          for (const v of viz) if (v >= 0 && v < N && m2[v] && !vis[v]) { vis[v] = 1; fila[q++] = v; }
        }
        total += cel.length;
        const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
        lista.push({ cel, area: cel.length, bw, bh, fill: cel.length / (bw * bh), y0, y1 });
      }
      lista.sort((a, b) => b.area - a.area);
      return { lista, frac: total / N };
    }
    const mediaRGB = (rgb, cel) => { let r = 0, g = 0, b = 0; for (const c of cel) { r += rgb[c * 3]; g += rgb[c * 3 + 1]; b += rgb[c * 3 + 2]; } const n = cel.length || 1; return [r / n, g / n, b / n]; };
    const distRGB = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    /* modelo de fundo: a faixa de cima da área (que deve ficar acima da pilha mais alta) na hora da calibração */
    function modeloFundo(am) {
      const cel = []; for (let j = 0; j < Math.max(2, Math.floor(REF_H * 0.22)); j++) for (let i = 0; i < REF_W; i++) cel.push(j * REF_W + i);
      S.fundo = mediaRGB(am.rgb, cel);
    }
    /* decide o que a mancha virou: ficou parecida com o fundo → retirada; senão → colocada */
    function direcao(mancha, atual, ref) {
      const cur = mediaRGB(atual.rgb, mancha.cel), ant = mediaRGB(ref.rgb, mancha.cel);
      if (!S.fundo) return +1;
      const dCur = distRGB(cur, S.fundo), dAnt = distRGB(ant, S.fundo);
      if (window.CAM_DEBUG) console.log('DIR', JSON.stringify({ area: mancha.area, y0: mancha.y0, y1: mancha.y1, cur: cur.map(Math.round), ant: ant.map(Math.round), fundo: S.fundo.map(Math.round), dCur: Math.round(dCur), dAnt: Math.round(dAnt) }));
      if (dCur < dAnt * 0.8) return -1;
      if (dCur > dAnt * 1.25) return +1;
      if (S.caixaCor) { return distRGB(cur, S.caixaCor) <= distRGB(cur, S.fundo) ? +1 : -1; }   // ambíguo: parece caixa ou fundo?
      return +1;
    }
    function aprenderCaixa(mancha, atual) {
      S.tamanhos.push(mancha.area); if (S.tamanhos.length > 20) S.tamanhos.shift();
      const cor = mediaRGB(atual.rgb, mancha.cel);
      S.caixaCor = S.caixaCor ? S.caixaCor.map((v, i) => v * 0.7 + cor[i] * 0.3) : cor;
    }
    const mediana = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[(s.length / 2) | 0]; };
    function sobrepoe(bx) {
      const z = S.zona; if (!bx || !z) return false;
      const ix = Math.max(0, Math.min(bx.x + bx.w, z.x + z.w) - Math.max(bx.x, z.x)), iy = Math.max(0, Math.min(bx.y + bx.h, z.y + z.h) - Math.max(bx.y, z.y));
      return ix * iy > 0.02 * z.w * z.h;
    }
    /* tamanho mínimo de uma mancha para valer como caixa (em células) — aprende sozinho; o tamanho marcado é só opcional */
    function limiares() {
      const s = S.cfg.sens || 5, z = S.zona;
      let min = N * (0.004 + (10 - s) * 0.0015), tipico = null;
      const med = S.tamanhos.length >= 3 ? mediana(S.tamanhos) : null;
      if (S.cfg.caixa && z && z.w * z.h > 0) { tipico = N * (S.cfg.caixa.w * S.cfg.caixa.h) / (z.w * z.h); min = Math.max(min * 0.5, tipico * 0.3); }
      else if (med) { tipico = med; min = Math.max(min, med * 0.35); }
      return { min, tipico };
    }
    function loop(t) {
      if (!S.ativo) return;
      S.raf = requestAnimationFrame(loop);
      if (!video.videoWidth) return;
      S.fpsN++; if (t - S.fpsT > 1000) { S.fps = S.fpsN; S.fpsN = 0; S.fpsT = t; }
      pctx.drawImage(video, 0, 0, PROC_W, PROC_H);
      if (S.pose && S.posePronto && !S.poseOcupado && t - S.ultimoPose > 180) { S.ultimoPose = t; S.poseOcupado = true; S.pose.send({ image: proc }).catch(() => {}).finally(() => { S.poseOcupado = false; }); }
      if (S.zona && !S.pausado) analisar(t);
      desenhar();
      if (t - S.ultimoEnvio > ENVIO_MS) { S.ultimoEnvio = t; enviarQuadro(); }
    }
    function analisar(t) {
      const atual = amostraZona(), L = limiares(), limMov = 14 + (10 - (S.cfg.sens || 5)) * 2;
      const mov = S.ultimoQuadro ? comparar(atual.g, S.ultimoQuadro.g, limMov).frac : 0;
      S.ultimoQuadro = atual;
      const presenca = mov > 0.015 || sobrepoe(S.pessoaBox);
      if (S.estado === 'calibrando') {
        if (!presenca) { if (!S.livreDesde) S.livreDesde = t; if (t - S.livreDesde > 1500) { S.ref = atual; S.refAnterior = null; modeloFundo(atual); S.estado = 'livre'; S.livreDesde = 0; } }
        else S.livreDesde = 0;
        return;
      }
      if (presenca) { if (S.estado !== 'ocupado') S.estado = 'ocupado'; S.livreDesde = 0; return; }
      if (S.estado === 'ocupado') { S.estado = 'assentando'; S.livreDesde = t; return; }
      const validas = m => m.lista.filter(b => b.area >= L.min && b.fill >= 0.3 && b.bw >= 3 && b.bh >= 3);
      if (S.estado === 'assentando') {
        if (t - S.livreDesde < 1200) return;
        if (validas(manchas(atual, S.ref, 18)).length) { S.estado = 'confirmando'; S.confirmandoDesde = t; } else S.estado = 'livre';
        return;
      }
      if (S.estado === 'confirmando') {
        if (t - S.confirmandoDesde < 2000) return;
        const m = manchas(atual, S.ref, 18), ok = validas(m);
        if (ok.length) {
          {
            // alguém que só parou na frente e saiu vira +1 seguido de −1 (retirada): o saldo fica certo
            let mais = 0, menos = 0;
            for (const b of ok) {
              const n = L.tipico ? Math.min(4, Math.max(1, Math.round(b.area / L.tipico))) : 1;   // mancha do tamanho de 2 caixas = 2
              if (direcao(b, atual, S.ref) > 0) { mais += n; aprenderCaixa(b, atual); } else menos += n;
            }
            if (m.frac > 0.6 || mais + menos > 6) { S.refAnterior = S.ref; S.ref = atual; registrar('troca_pallet', 0, m.frac); }
            else {
              S.refAnterior = S.ref; S.ref = atual; S.ultimaContagemTs = t;
              if (mais) registrar('ia', mais, m.frac);
              if (menos) registrar('ia_retirada', menos, m.frac);
            }
          }
        }
        S.estado = 'livre';
        return;
      }
      if (S.ref) { for (let i = 0; i < N; i++) S.ref.g[i] += (atual.g[i] - S.ref.g[i]) * 0.02; for (let i = 0; i < N * 3; i++) S.ref.rgb[i] += (atual.rgb[i] - S.ref.rgb[i]) * 0.02; }
    }

    /* ───────── registro ───────── */
    function miniatura() {
      const c = document.createElement('canvas'); c.width = 320; c.height = 240; const cx = c.getContext('2d'); cx.drawImage(video, 0, 0, 320, 240);
      if (S.zona) { cx.strokeStyle = '#35C95C'; cx.lineWidth = 2; cx.strokeRect(S.zona.x * 320, S.zona.y * 240, S.zona.w * 320, S.zona.h * 240); }
      return c.toDataURL('image/jpeg', 0.6);
    }
    function registrar(origem, valor, frac) {
      if (origem === 'manual_mais') valor = 1; else if (origem === 'manual_menos') valor = -1; else if (origem === 'troca_pallet') valor = 0; else if (origem === 'ia_retirada') valor = -Math.abs(valor || 1);
      const ev = { linha_id: S.linhaId, sessao_id: S.sessaoId || (S.sessao ? S.sessao.id : null), origem, valor: Math.abs(valor) || undefined, ts: new Date().toISOString(), mudanca_pct: frac != null ? Math.round(frac * 1000) / 10 : null, foto: miniatura(), dispositivo: disp };
      if (valor) { S.contagem += valor; o.onContagem && o.onContagem(S.contagem); if (o.flash) { o.flash.classList.add('on'); setTimeout(() => o.flash.classList.remove('on'), 250); } if (navigator.vibrate) navigator.vibrate(60); }
      S.eventos.push({ ts: ev.ts, valor, origem });
      o.onEvento && o.onEvento({ ...ev, valor });
      S.fila.push(ev); salvarFila(); enviarFila();
    }
    function salvarFila() { try { localStorage.setItem('contador.fila', JSON.stringify(S.fila)); } catch (_) {} }
    let enviando = false;
    async function enviarFila() {
      if (enviando || !S.fila.length) return; enviando = true;
      while (S.fila.length) {
        try { await API.post('/api/contador/eventos', S.fila[0]); S.fila.shift(); salvarFila(); o.onOffline && o.onOffline(false); }
        catch (e) { if (e.status && e.status < 500 && e.status !== 401) { S.fila.shift(); salvarFila(); } else { o.onOffline && o.onOffline(true); break; } }
      }
      enviando = false;
    }
    async function carregarEventosHoje() {
      const lista = await API.get(`/api/contador/eventos?data=${hojeISO()}&linha_id=${S.linhaId}${S.sessaoId ? '&sessao_id=' + S.sessaoId : ''}`).catch(() => []);
      S.eventos = lista.map(e => ({ ts: e.ts, valor: e.valor, origem: e.origem }));
      const vFila = f => f.origem === 'manual_menos' || f.origem === 'estorno' ? -1 : f.origem === 'ia_retirada' ? -(f.valor || 1) : f.origem === 'troca_pallet' ? 0 : (f.valor || 1);
      S.contagem = S.eventos.reduce((s, e) => s + e.valor, 0) + S.fila.filter(f => f.linha_id === S.linhaId).reduce((s, f) => s + vFila(f), 0);
      o.onContagem && o.onContagem(S.contagem);
    }

    /* ───────── desenho ───────── */
    function desenhar() {
      if (!sobre) return;
      const W = sobre.width = sobre.clientWidth, H = sobre.height = sobre.clientHeight;
      sctx.clearRect(0, 0, W, H);
      const vr = video.videoWidth / video.videoHeight, cr = W / H;
      let sx = 0, sy = 0, sw = 1, sh = 1;
      if (vr > cr) { sw = cr / vr; sx = (1 - sw) / 2; } else { sh = vr / cr; sy = (1 - sh) / 2; }
      const mapX = x => (x - sx) / sw * W, mapY = y => (y - sy) / sh * H;
      const z = S.desenhando || S.zona;
      if (z) {
        sctx.strokeStyle = S.estado === 'ocupado' ? '#F0B429' : (S.estado === 'assentando' || S.estado === 'confirmando') ? '#56B6E0' : '#35C95C';
        sctx.lineWidth = 3; sctx.setLineDash(S.estado === 'calibrando' ? [8, 6] : []);
        sctx.strokeRect(mapX(z.x), mapY(z.y), z.w / sw * W, z.h / sh * H); sctx.setLineDash([]);
        sctx.fillStyle = 'rgba(53,201,92,.08)'; sctx.fillRect(mapX(z.x), mapY(z.y), z.w / sw * W, z.h / sh * H);
        if (S.cfg.caixa && S.cfg.caixa_pos) { sctx.strokeStyle = 'rgba(240,180,41,.8)'; sctx.lineWidth = 1.5; sctx.setLineDash([4, 3]); sctx.strokeRect(mapX(S.cfg.caixa_pos.x), mapY(S.cfg.caixa_pos.y), S.cfg.caixa.w / sw * W, S.cfg.caixa.h / sh * H); sctx.setLineDash([]); }
      }
      if (S.pessoaBox) { sctx.strokeStyle = 'rgba(86,182,224,.9)'; sctx.lineWidth = 2; sctx.strokeRect(mapX(S.pessoaBox.x), mapY(S.pessoaBox.y), S.pessoaBox.w / sw * W, S.pessoaBox.h / sh * H); }
      const nomes = { calibrando: 'Calibrando — saia da frente do pallet', livre: 'Livre', ocupado: 'Pessoa no pallet', assentando: 'Conferindo…', confirmando: 'Confirmando…' };
      const txt = (S.pausado ? 'PAUSADO · ' : '') + (S.zona ? nomes[S.estado] : 'Sem área marcada') + ' · ' + S.fps + ' fps';
      hud('estado', txt, S.estado === 'ocupado' ? 'alerta' : S.estado === 'livre' ? 'on' : '');
      o.onEstado && o.onEstado(S.zona ? S.estado : 'sem_area', txt);
      desenhar.map = { sx, sy, sw, sh };
    }
    /* marcar área/caixa arrastando no próprio aparelho (também salva no servidor) */
    let modoDesenho = 'zona', ini = null;
    function toqueParaNorm(e) { const r = sobre.getBoundingClientRect(); const m = desenhar.map || { sx: 0, sy: 0, sw: 1, sh: 1 }; return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width * m.sw + m.sx)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height * m.sh + m.sy)) }; }
    if (sobre) {
      sobre.addEventListener('pointerdown', e => { if (!o.desenhoLocal || !S.ativo) return; if (e.cancelable) e.preventDefault(); try { sobre.setPointerCapture(e.pointerId); } catch (_) {} ini = toqueParaNorm(e); S.desenhando = { x: ini.x, y: ini.y, w: 0, h: 0 }; });
      sobre.addEventListener('pointermove', e => { if (!ini) return; if (e.cancelable) e.preventDefault(); const p = toqueParaNorm(e); S.desenhando = { x: Math.min(ini.x, p.x), y: Math.min(ini.y, p.y), w: Math.abs(p.x - ini.x), h: Math.abs(p.y - ini.y) }; });
      const soltar = async () => {
        if (!ini) return; const d = S.desenhando; ini = null; S.desenhando = null;
        if (!d || d.w < 0.03 || d.h < 0.03) return;
        if (modoDesenho === 'zona') { S.zona = d; recalibrar(); S.zonaEditadaLocal = true; await salvarConfig({ zona: d }, false); avisoOk('Área marcada. Calibrando…'); }
        else { await salvarConfig({ caixa: { w: d.w, h: d.h }, caixa_pos: { x: d.x, y: d.y } }, true); avisoOk('Tamanho da caixa salvo para este produto.'); }
      };
      sobre.addEventListener('pointerup', soltar); sobre.addEventListener('pointercancel', soltar);
    }
    async function salvarConfig(parcial, porProduto) {
      try {
        const body = { ...parcial }; if (porProduto && S.produtoId) body.produto_id = S.produtoId;
        const r = await API.put('/api/contador/linhas/' + S.linhaId + '/config', body);
        S.cfgTs = r.updated_at; S.cfg = { ...S.cfg, ...r.config }; o.onConfig && o.onConfig(S.cfg, S.zona);
      } catch (e) { avisoErro(e.message); }
    }

    /* ───────── ao vivo ───────── */
    let enviandoQuadro = false;
    async function enviarQuadro() {
      if (enviandoQuadro || !video.videoWidth) return; enviandoQuadro = true;
      try {
        ectx.drawImage(video, 0, 0, 480, 360);
        if (S.zona) { ectx.strokeStyle = S.estado === 'ocupado' ? 'rgba(240,180,41,.9)' : 'rgba(53,201,92,.9)'; ectx.lineWidth = 2; ectx.strokeRect(S.zona.x * 480, S.zona.y * 360, S.zona.w * 480, S.zona.h * 360); }
        ectx.fillStyle = 'rgba(10,22,32,.7)'; ectx.fillRect(0, 0, 480, 26);
        ectx.fillStyle = '#fff'; ectx.font = 'bold 14px sans-serif';
        ectx.fillText(`${(S.linha && (S.linha.nome || S.linha.celula)) || ''}  ·  ${S.contagem} un  ·  ${new Date().toLocaleTimeString('pt-BR')}`, 10, 18);
        const body = { linha_id: S.linhaId, produto_id: S.produtoId, sessao_id: S.sessaoId || (S.sessao ? S.sessao.id : null), contagem: S.contagem, estado: S.zona ? S.estado : 'sem_area', dispositivo: disp, jpeg: envio.toDataURL('image/jpeg', 0.55) };
        if (S.capacidades && !S.capEnviadas) body.capacidades = S.capacidades;
        const r = await fetch('/api/contador/frame', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (r.status === 401) location.href = '/login';
        if (r.ok) { S.capEnviadas = true; const j = await r.json().catch(() => ({})); if (j.comandos) sincronizar(false).catch(() => {}); }
        hud('live', null, r.ok ? 'on' : 'erro');
      } catch (_) { hud('live', null, 'erro'); }
      enviandoQuadro = false;
    }

    /* ───────── ciclo de vida ───────── */
    async function conectar(p) {
      S.linhaId = Number(p.linhaId); S.produtoId = p.produtoId ? Number(p.produtoId) : null; S.sessaoId = p.sessaoId ? Number(p.sessaoId) : null;
      try { await sincronizar(true); } catch (e) { throw new Error('Linha não encontrada: ' + e.message); }
      await abrirCamera();
      S.ativo = true;
      if (typeof manterTelaLigada === 'function') manterTelaLigada();
      await carregarEventosHoje();
      iniciarPose();
      S.raf = requestAnimationFrame(loop);
      S.timers.push(setInterval(enviarFila, 4000), setInterval(() => sincronizar(false).catch(() => {}), POLL_MS));
      document.addEventListener('visibilitychange', onVis);
      return S;
    }
    function onVis() { S.pausado = document.hidden; }
    function parar() {
      S.ativo = false; cancelAnimationFrame(S.raf); S.timers.forEach(clearInterval); S.timers = [];
      if (S.stream) S.stream.getTracks().forEach(t => t.stop()); S.stream = null; video.srcObject = null;
      document.removeEventListener('visibilitychange', onVis);
      if (S.pose) { try { S.pose.close(); } catch (_) {} S.pose = null; S.posePronto = false; }
    }
    /* troca de produto/sessão sem reabrir a câmera (o tablet trocou a linha) */
    async function trocarSessao(produtoId, sessaoId) { S.produtoId = produtoId ? Number(produtoId) : null; S.sessaoId = sessaoId ? Number(sessaoId) : null; await sincronizar(true); await carregarEventosHoje(); }

    return {
      conectar, parar, trocarSessao, registrar: (origem) => registrar(origem, 0, null), recalibrar: () => { recalibrar(); },
      trocaPallet: () => { recalibrar(); registrar('troca_pallet', 0, null); },
      modoDesenho: m => { modoDesenho = m; }, salvarConfig, estado: S,
      get contagem() { return S.contagem; }, get sessao() { return S.sessao; }, get eventos() { return S.eventos; }, get cfg() { return S.cfg; }, get zona() { return S.zona; }, get ativo() { return S.ativo; }
    };
  }
  return { criar, CFG_PADRAO };
})();
