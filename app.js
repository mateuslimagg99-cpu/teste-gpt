import { parseZpl, encodeUnit } from './zpl.js';
import { norm, toReadingCoords, parseDacePage, mergeDaces, parsePackingPage, matchPacking } from './parse.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const FONT = 'Arial, "Helvetica Neue", Helvetica, "Liberation Sans", sans-serif';
const DPI = 203; // resolução da térmica: 1 ponto da etiqueta = 1 ponto impresso
const LS_APELIDOS = 'etq.apelidos.v1', LS_OPTS = 'etq.opts.v1', LS_LOGO = 'etq.logo.v1';

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } },
};

let apelidos = store.get(LS_APELIDOS, {});
const opts = Object.assign({ stamp: true, variacao: true, order: 'orig', logo: true }, store.get(LS_OPTS, {}));
let state = null; // { prefix, labels: [...] }
let logoImg = null;
const LOGO_PADRAO = 'logo-padrao.png'; // logo da Sintonia Ateliê (perfil da loja na Shopee)
function loadLogo() {
  const proprio = store.get(LS_LOGO, null);
  const src = proprio || LOGO_PADRAO;
  logoImg = null;
  $('#logoPrev').hidden = false;
  $('#logoDel').hidden = !proprio;
  $('#logoPrev').src = src;
  return new Promise(res => { const im = new Image(); im.onload = () => { logoImg = im; res(); }; im.onerror = () => res(); im.src = src; });
}
const logoReady = loadLogo();

// ---------------- entrada de arquivos ----------------
const drop = $('#drop'), fileInput = $('#file');
['dragenter', 'dragover'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', ev => handleFiles([...ev.dataTransfer.files]));
fileInput.addEventListener('change', () => { handleFiles([...fileInput.files]); fileInput.value = ''; });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { if (!drop.contains(e.target)) { e.preventDefault(); handleFiles([...e.dataTransfer.files]); } });

function setStatus(msg, cls = '') {
  const el = $('#status');
  el.hidden = !msg; el.className = 'status ' + cls; el.innerHTML = msg || '';
}

async function expandFiles(files) {
  const out = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const zip = await JSZip.loadAsync(f);
      for (const e of Object.values(zip.files)) {
        if (e.dir || /(^|\/)__MACOSX\//.test(e.name)) continue;
        out.push({ name: e.name.split('/').pop(), bytes: new Uint8Array(await e.async('uint8array')) });
      }
    } else out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  return out;
}

let pdfjsLib = null;
async function pdfPages(bytes) {
  if (!pdfjsLib) {
    pdfjsLib = await import('./vendor/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
  }
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i);
    const vp = pg.getViewport({ scale: 1 });
    const tc = await pg.getTextContent();
    pages.push(toReadingCoords(tc.items, vp.transform, pdfjsLib.Util.transform));
  }
  return pages;
}

async function handleFiles(files) {
  if (!files.length) return;
  try {
    setStatus('Lendo arquivos…');
    const all = await expandFiles(files);
    const zplFiles = [], daces = [], blocks = [];
    for (const f of all) {
      const head = new TextDecoder('latin1').decode(f.bytes.subarray(0, 5));
      if (head.startsWith('%PDF')) {
        const pages = await pdfPages(f.bytes);
        const txt = pages.map(p => p.map(x => x.s).join(' ')).join(' ');
        if (/DACE|DECLARA[CÇ][AÃ]O AUXILIAR|CONTE[UÚ]DO/i.test(txt)) daces.push(...pages.map(parseDacePage));
        else if (/ID\s*Pedido|Checklist de carregamento/i.test(txt)) blocks.push(...pages.flatMap(parsePackingPage));
      } else if (/\.(txt|zpl|prn)$/i.test(f.name) || /\^XA|~DG/.test(new TextDecoder('latin1').decode(f.bytes.subarray(0, 200)))) {
        zplFiles.push(f);
      }
    }
    if (!zplFiles.length) {
      setStatus('Não achei a etiqueta <b>ZPL</b> (arquivo .txt) no que você enviou. Na Shopee, baixe a opção <b>"Etiqueta de Envio ZPL + Declaração de Conteúdo + Lista de Empacotamento"</b>.', 'err');
      return;
    }
    let prefix = '', units = [];
    for (const f of zplFiles) {
      const z = await parseZpl(new TextDecoder('latin1').decode(f.bytes));
      if (!units.length) prefix = z.prefix;
      units.push(...z.units);
    }
    if (!units.length) {
      setStatus('O arquivo ZPL não tem a etiqueta em imagem, que é o formato que a Shopee usa. Não consegui ler este arquivo.', 'err');
      return;
    }
    setStatus(`Lendo ${units.length} etiqueta(s)…`);
    await logoReady;
    await buildState(prefix, units, mergeDaces(daces), blocks);
    setStatus('');
  } catch (e) {
    console.error(e);
    setStatus('Deu erro ao ler os arquivos: ' + esc(e.message || e), 'err');
  }
}

// ---------------- etiquetas ----------------
function bitsToCanvas(u) {
  const c = document.createElement('canvas');
  c.width = u.width; c.height = u.height;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(u.width, u.height);
  const d = img.data, bpr = u.bpr;
  for (let y = 0; y < u.height; y++) for (let x = 0; x < u.width; x++) {
    const on = (u.bits[y * bpr + (x >> 3)] >> (7 - (x & 7))) & 1;
    const i = (y * u.width + x) * 4, v = on ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function canvasToBits(c, bpr) {
  const { width: w, height: h } = c;
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  const bits = new Uint8Array(bpr * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11 < 150) bits[y * bpr + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return bits;
}

function readQR(canvas, x0, y0, x1, y1) {
  const W = canvas.width, H = canvas.height;
  const sx = Math.round(x0 * W), sy = Math.round(y0 * H), sw = Math.round((x1 - x0) * W), sh = Math.round((y1 - y0) * H);
  for (const scale of [1, 2]) {
    const pad = 24;
    const c = document.createElement('canvas');
    c.width = sw * scale + pad * 2; c.height = sh * scale + pad * 2;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, sx, sy, sw, sh, pad, pad, sw * scale, sh * scale);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const r = jsQR(img.data, c.width, c.height, { inversionAttempts: 'dontInvert' });
    if (r && r.data) return r.data;
  }
  return null;
}

// maior faixa horizontal totalmente em branco no meio da etiqueta
function findBlankBand(u) {
  const rowBlank = y => { for (let k = 0; k < u.bpr; k++) if (u.bits[y * u.bpr + k]) return false; return true; };
  let best = null, start = -1;
  const y0 = Math.floor(u.height * 0.2), y1 = Math.floor(u.height * 0.85);
  for (let y = y0; y <= y1; y++) {
    const b = y < y1 && rowBlank(y);
    if (b && start < 0) start = y;
    if (!b && start >= 0) { if (!best || y - start > best.h) best = { y: start, h: y - start }; start = -1; }
  }
  return best && best.h >= 36 ? best : null;
}

// área em branco à direita do nome do remetente (antes do QR)
function findLogoBox(u) {
  const x0 = Math.round(u.width * 0.235), x1 = Math.round(u.width * 0.615);
  const ya = Math.round(u.height * 0.64), yb = Math.round(u.height * 0.80);
  const black = (x, y) => (u.bits[y * u.bpr + (x >> 3)] >> (7 - (x & 7))) & 1;
  const blankRow = y => { for (let x = x0; x < x1; x++) if (black(x, y)) return false; return true; };
  let best = null, start = -1;
  for (let y = ya; y <= yb; y++) {
    const b = y < yb && blankRow(y);
    if (b && start < 0) start = y;
    if (!b && start >= 0) { if (!best || y - start > best.h) best = { y: start, h: y - start }; start = -1; }
  }
  if (!best || best.h < 40) return null;
  return { x: x0 + 6, y: best.y + 4, w: x1 - x0 - 12, h: best.h - 8 };
}

function drawLogo(canvas, box) {
  const r = Math.min(box.w / logoImg.width, box.h / logoImg.height);
  const w = Math.max(1, Math.round(logoImg.width * r)), h = Math.max(1, Math.round(logoImg.height * r));
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const tc = t.getContext('2d');
  tc.fillStyle = '#fff'; tc.fillRect(0, 0, w, h);
  tc.imageSmoothingQuality = 'high';
  tc.drawImage(logoImg, 0, 0, w, h);
  const img = tc.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11 < 160 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  tc.putImageData(img, 0, 0);
  canvas.getContext('2d').drawImage(t, box.x, box.y + Math.round((box.h - h) / 2));
}

function wrap(ctx, text, maxW) {
  const words = text.split(/\s+/); const lines = []; let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width <= maxW || !line) line = t; else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

function stampText(canvas, band, text) {
  const ctx = canvas.getContext('2d');
  const padY = 5, padX = 18;
  const maxW = canvas.width - padX * 2, maxH = band.h - padY * 2;
  let size = Math.min(46, Math.floor(maxH * 0.9)), lines, lh;
  for (; size >= 15; size--) {
    ctx.font = `700 ${size}px ${FONT}`;
    lh = Math.round(size * 1.12);
    lines = wrap(ctx, text, maxW);
    if (lines.length * lh <= maxH && lines.every(l => ctx.measureText(l).width <= maxW)) break;
  }
  if (size < 15) { // não coube: corta com reticências
    size = 15; ctx.font = `700 ${size}px ${FONT}`; lh = Math.round(size * 1.12);
    const max = Math.max(1, Math.floor(maxH / lh));
    lines = wrap(ctx, text, maxW).slice(0, max);
    let last = lines[max - 1] || '';
    while (last && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    lines[lines.length - 1] = last + '…';
  }
  ctx.fillStyle = '#fff'; ctx.fillRect(0, band.y, canvas.width, band.h);
  ctx.fillStyle = '#000'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  const top = band.y + band.h / 2 - (lines.length * lh) / 2 + lh / 2;
  lines.forEach((l, i) => ctx.fillText(l, canvas.width / 2, top + i * lh));
}

// deixa só preto e branco (sem cinza do antialias), como a térmica imprime
function toPureBW(c, y, h) {
  const ctx = c.getContext('2d');
  const img = ctx.getImageData(0, y, c.width, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11 < 150 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, y);
}

async function buildState(prefix, units, daces, blocks) {
  const daceByKey = new Map(daces.map(d => [d.chave, d]));
  const labels = units.map((u, i) => {
    const base = bitsToCanvas(u);
    const qrDace = readQR(base, 0, 0.8, 0.3, 1) || readQR(base, 0, 0.6, 0.5, 1);
    const chave = (qrDace && (qrDace.match(/chDCe=(\d{44})/) || qrDace.match(/(\d{44})/)) || [])[1] || null;
    let tracking = readQR(base, 0.6, 0.03, 1, 0.3) || readQR(base, 0.05, 0.2, 0.45, 0.5);
    if (tracking && /^https?:/i.test(tracking)) tracking = null;
    let dace = chave ? daceByKey.get(chave) : null;
    let viaOrdem = false;
    if (!dace && !chave && daces.length === units.length) { dace = daces[i]; viaOrdem = true; }
    return { orig: i, unit: u, base, chave, tracking, dace, viaOrdem, band: findBlankBand(u), logoBox: findLogoBox(u) };
  });
  const matches = matchPacking(labels.map(l => l.dace ? l.dace.itens : null), blocks);
  labels.forEach((l, i) => {
    const m = matches[i];
    l.pedido = m && !m.ambiguous ? m.block.pedido : '';
    l.itens = (l.dace ? l.dace.itens : []).map(it => {
      let variacao = '', varOk = true;
      if (m) {
        const bi = m.block.itens.find(x => norm(x.produto).startsWith(norm(it.desc).slice(0, 25)) || norm(it.desc).startsWith(norm(x.produto).slice(0, 25)));
        if (!m.ambiguous || m.sameVariation) variacao = bi ? bi.variacao : '';
        else { variacao = m.variacoes.join(' / '); varOk = false; }
      }
      return { desc: it.desc, qtd: it.qtd, valor: it.valor, variacao, varOk, key: norm(it.desc) };
    });
  });
  state = { prefix, labels, hasDace: daces.length > 0, hasPacking: blocks.length > 0 };
  render();
}

function displayName(it) { return (apelidos[it.key] || '').trim() || it.desc; }

function labelText(l) {
  if (!l.itens.length) return '';
  return l.itens.map(it => {
    let s = `${it.qtd}x ${displayName(it)}`;
    if (opts.variacao && it.variacao) s += it.varOk ? ` · ${it.variacao}` : ` · (${it.variacao}?)`;
    return s;
  }).join('  +  ');
}

function orderedLabels() {
  const ls = [...state.labels];
  if (opts.order === 'prod') {
    const k = l => l.itens.length ? displayName(l.itens[0]).toLowerCase() + '|' + (l.itens[0].variacao || '') : '~';
    ls.sort((a, b) => k(a).localeCompare(k(b), 'pt') || a.orig - b.orig);
  }
  return ls;
}

function renderLabelImages() {
  for (const l of state.labels) {
    const c = document.createElement('canvas');
    c.width = l.base.width; c.height = l.base.height;
    c.getContext('2d').drawImage(l.base, 0, 0);
    const txt = labelText(l);
    l.stamped = !!(opts.stamp && txt && l.band);
    if (l.stamped) { stampText(c, l.band, txt); toPureBW(c, l.band.y, l.band.h); }
    l.logo = !!(opts.logo && logoImg && l.logoBox);
    if (l.logo) drawLogo(c, l.logoBox);
    l.canvas = c;
    l.url = c.toDataURL('image/png');
  }
}

// ---------------- telas ----------------
function pickRows(ls) {
  const map = new Map();
  ls.forEach((l, n) => l.itens.forEach(it => {
    const k = it.key + '|' + (it.varOk ? norm(it.variacao) : '?');
    if (!map.has(k)) map.set(k, { it, qtd: 0, nums: [] });
    const r = map.get(k); r.qtd += it.qtd; r.nums.push(n + 1);
  }));
  return [...map.values()].sort((a, b) => displayName(a.it).localeCompare(displayName(b.it), 'pt'));
}

function render() {
  $('#drop').classList.add('compact');
  $('#result').hidden = false;
  $('#optLogo').checked = opts.logo;
  $('#optStamp').checked = opts.stamp; $('#optVar').checked = opts.variacao; $('#optOrder').value = opts.order;
  renderLabelImages();
  const ls = orderedLabels();

  // avisos gerais
  const warns = [];
  if (!state.hasDace) warns.push('Não veio a <b>declaração de conteúdo</b> (PDF): sem ela não dá para saber o produto de cada etiqueta.');
  const semProd = ls.filter(l => !l.itens.length).length;
  if (state.hasDace && semProd) warns.push(`${semProd} etiqueta(s) sem produto identificado.`);
  if (ls.some(l => l.viaOrdem)) warns.push('Algumas etiquetas foram casadas pela ordem do arquivo (não consegui ler o QR da declaração). Confira.');
  if (ls.some(l => l.itens.some(i => !i.varOk))) warns.push('Há pedidos do mesmo produto com variações diferentes: nessas etiquetas a variação aparece com "?" e precisa ser conferida na lista de empacotamento.');
  if (opts.stamp && ls.some(l => l.itens.length && !l.band)) warns.push('Em alguma etiqueta não achei espaço em branco para escrever o produto.');
  if (warns.length) setStatus(warns.join('<br>'), 'warn'); else setStatus('');

  // tabela de separação
  const rows = pickRows(ls);
  const total = rows.reduce((s, r) => s + r.qtd, 0);
  $('#pickTable').innerHTML = `<thead><tr><th>Qtd</th><th>Produto (apelido para a etiqueta)</th><th>Variação</th><th>Etiquetas</th></tr></thead><tbody>` +
    rows.map(r => `<tr>
      <td class="qtd">${r.qtd}</td>
      <td><input data-key="${esc(r.it.key)}" value="${esc(apelidos[r.it.key] || '')}" placeholder="${esc(r.it.desc.slice(0, 60))}">
          <div class="full">${esc(r.it.desc)}</div></td>
      <td>${esc(r.it.variacao || '—')}${r.it.varOk ? '' : ' <span class="tag warn">conferir</span>'}</td>
      <td class="nums">#${r.nums.join(', #')}</td></tr>`).join('') +
    `<tr><td class="qtd">${total}</td><td colspan="3"><b>itens no total · ${ls.length} pacote(s)</b></td></tr></tbody>`;
  $('#pickTable').querySelectorAll('input').forEach(inp => {
    inp.addEventListener('change', () => {
      const k = inp.dataset.key, v = inp.value.trim();
      if (v) apelidos[k] = v; else delete apelidos[k];
      store.set(LS_APELIDOS, apelidos);
      render();
    });
  });

  // cartões
  $('#countLbl').textContent = ls.length;
  $('#cards').innerHTML = ls.map((l, n) => {
    const d = l.dace;
    const tags = [];
    if (l.itens.length) tags.push(l.viaOrdem ? '<span class="tag warn">casado pela ordem</span>' : '<span class="tag ok">produto confirmado pela declaração</span>');
    else tags.push('<span class="tag bad">produto não identificado</span>');
    return `<div class="card">
      <img src="${l.url}" alt="Etiqueta ${n + 1}">
      <div class="info">
        <div class="num">#${n + 1}${l.tracking ? ' · ' + esc(l.tracking) : ''}</div>
        <div class="prod">${l.itens.length ? esc(labelText(l)) : '—'}</div>
        <div class="meta">${d ? esc(d.destNome) + ' · ' + esc(d.destCidade) : ''}${l.pedido ? '<br>Pedido ' + esc(l.pedido) : ''}</div>
        ${tags.join(' ')}
      </div></div>`;
  }).join('');

  // área de impressão
  $('#printLabels').innerHTML = ls.map(l => `<div class="lbl-page"><img src="${l.url}" style="width:${(l.canvas.width / DPI).toFixed(4)}in;height:${(l.canvas.height / DPI).toFixed(4)}in"></div>`).join('');
  const hoje = new Date().toLocaleDateString('pt-BR');
  $('#printPick').innerHTML = `<h1>Separação · ${hoje} · ${ls.length} pacote(s), ${total} item(ns)</h1>
    <table><thead><tr><th class="box"></th><th>Qtd</th><th>Produto</th><th>Variação</th><th>Etiquetas</th></tr></thead><tbody>` +
    rows.map(r => `<tr><td class="box"></td><td class="q">${r.qtd}</td><td>${esc(displayName(r.it))}</td><td>${esc(r.it.variacao || '—')}${r.it.varOk ? '' : ' (conferir)'}</td><td>#${r.nums.join(', #')}</td></tr>`).join('') +
    `</tbody></table><h1 style="margin-top:8mm">Pacotes</h1>
    <table><thead><tr><th class="box"></th><th>#</th><th>Destinatário</th><th>Produto(s)</th><th>Rastreio</th></tr></thead><tbody>` +
    ls.map((l, n) => `<tr><td class="box"></td><td>${n + 1}</td><td>${esc(l.dace ? l.dace.destNome + ' · ' + l.dace.destCidade : '')}</td><td>${esc(labelText(l))}</td><td>${esc(l.tracking || '')}</td></tr>`).join('') +
    `</tbody></table>`;
}

// ---------------- ações ----------------
function doPrint(kind) {
  let st = document.getElementById('pageStyle');
  if (!st) { st = document.createElement('style'); st.id = 'pageStyle'; document.head.appendChild(st); }
  st.textContent = kind === 'labels' ? '@page{size:100mm 150mm;margin:0}' : '@page{size:A4;margin:12mm}';
  document.body.classList.remove('p-labels', 'p-pick');
  document.body.classList.add(kind === 'labels' ? 'p-labels' : 'p-pick');
  setTimeout(() => window.print(), 50);
}
window.addEventListener('afterprint', () => document.body.classList.remove('p-labels', 'p-pick'));

$('#btnPrint').addEventListener('click', () => doPrint('labels'));
$('#btnPick').addEventListener('click', () => doPrint('pick'));
$('#btnReset').addEventListener('click', () => { state = null; $('#result').hidden = true; $('#drop').classList.remove('compact'); setStatus(''); fileInput.click(); });

$('#btnZpl').addEventListener('click', async () => {
  const btn = $('#btnZpl'); btn.disabled = true;
  try {
    const parts = [state.prefix];
    for (const l of orderedLabels()) {
      const bits = (l.stamped || l.logo) ? canvasToBits(l.canvas, l.unit.bpr) : l.unit.bits;
      parts.push(await encodeUnit(l.unit, bits));
    }
    const blob = new Blob([parts.join('')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `etiquetas_com_produto_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { setStatus('Erro ao gerar o ZPL: ' + esc(e.message || e), 'err'); }
  btn.disabled = false;
});

$('#optLogo').addEventListener('change', e => { opts.logo = e.target.checked; store.set(LS_OPTS, opts); if (state) render(); });
$('#logoFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const im = new Image();
  im.src = URL.createObjectURL(f);
  await im.decode().catch(() => null);
  if (!im.width) { setStatus('Não consegui abrir essa imagem.', 'err'); return; }
  const r = Math.min(1, 600 / Math.max(im.width, im.height)); // guarda reduzido
  const c = document.createElement('canvas');
  c.width = Math.round(im.width * r); c.height = Math.round(im.height * r);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(im, 0, 0, c.width, c.height);
  store.set(LS_LOGO, c.toDataURL('image/png'));
  opts.logo = true; store.set(LS_OPTS, opts);
  await loadLogo();
  if (state) render();
});
$('#logoDel').addEventListener('click', async () => { localStorage.removeItem(LS_LOGO); await loadLogo(); if (state) render(); });
$('#optStamp').addEventListener('change', e => { opts.stamp = e.target.checked; store.set(LS_OPTS, opts); render(); });
$('#optVar').addEventListener('change', e => { opts.variacao = e.target.checked; store.set(LS_OPTS, opts); render(); });
$('#optOrder').addEventListener('change', e => { opts.order = e.target.value; store.set(LS_OPTS, opts); render(); });
