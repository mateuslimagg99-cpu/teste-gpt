// Leitura dos PDFs da Shopee (DACE e lista de empacotamento) a partir dos
// itens de texto do pdf.js já convertidos para coordenadas de leitura (u,v):
// u cresce no sentido da leitura, v cresce de cima para baixo.

export const norm = s => (s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();

// Converte itens do pdf.js para {s,u,v}. `vpTransform` é viewport.transform,
// `mul` é pdfjsLib.Util.transform. Detecta texto girado (lista de empacotamento).
export function toReadingCoords(items, vpTransform, mul) {
  const pts = [];
  const dirCount = new Map();
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const t = mul(vpTransform, it.transform);
    const len = Math.hypot(t[0], t[1]) || 1;
    const dx = Math.round(t[0] / len), dy = Math.round(t[1] / len);
    const key = dx + ',' + dy;
    dirCount.set(key, (dirCount.get(key) || 0) + 1);
    pts.push({ s: it.str.trim(), x: t[4], y: t[5], key });
  }
  let best = '1,0', n = -1;
  for (const [k, c] of dirCount) if (c > n) { n = c; best = k; }
  const [dx, dy] = best.split(',').map(Number);
  return pts.filter(p => p.key === best).map(p => ({
    s: p.s,
    u: p.x * dx + p.y * dy,
    v: -p.x * dy + p.y * dx,
  }));
}

const find = (pts, re) => pts.find(p => re.test(p.s));

// ---------- DACE (declaração de conteúdo) ----------
export function parseDacePage(pts) {
  const out = { chave: null, numero: null, emissao: null, destNome: '', destDoc: '', destCidade: '', destEnd: '', itens: [] };
  for (const p of pts) {
    const d = p.s.replace(/\s/g, '');
    if (!out.chave && /^\d{44}$/.test(d)) out.chave = d;
    const mN = p.s.match(/N\.?\s*º\s*(\d{4,})/);
    if (mN && !out.numero) out.numero = mN[1];
    const mE = p.s.match(/\b\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}/);
    if (mE && !out.emissao) out.emissao = mE[0];
  }
  if (!out.chave) {
    const all = pts.map(p => p.s).join(' ');
    const m = all.match(/\b\d{44}\b/);
    if (m) out.chave = m[0];
  }
  const below = (h, uMin, uMax) => pts
    .filter(p => p.v > h.v + 2 && p.v < h.v + 20 && p.u >= uMin && p.u < uMax)
    .sort((a, b) => a.v - b.v || a.u - b.u).map(p => p.s).join(' ').trim();

  const hDoc = find(pts, /CNPJ\/CPF\s+DESTINAT/i);
  const hNome = find(pts, /^NOME\s+DESTINAT/i);
  const hCid = find(pts, /CIDADE-UF\s+DESTINAT/i);
  const hEnd = find(pts, /ENDERE[CÇ]O\s+DESTINAT/i);
  if (hNome) {
    out.destNome = below(hNome, hNome.u - 10, Infinity);
    if (hDoc) out.destDoc = below(hDoc, -Infinity, hNome.u - 10);
  }
  if (hEnd) {
    out.destEnd = below(hEnd, hEnd.u - 10, Infinity);
    if (hCid) out.destCidade = below(hCid, -Infinity, hEnd.u - 10);
  }

  // Tabela de bens
  const hDesc = find(pts, /^DESCRI[CÇ][AÃ]O$/i);
  const hQtd = find(pts, /^QUANTIDADE$/i);
  const hVal = find(pts, /^VALOR$/i);
  const hTot = find(pts, /VALOR TOTAL/i);
  if (hDesc && hQtd) {
    const vEnd = hTot ? hTot.v - 1 : Infinity;
    const rows = pts.filter(p => p.v > hDesc.v + 2 && p.v < vEnd).sort((a, b) => a.v - b.v || a.u - b.u);
    let cur = null;
    for (const p of rows) {
      if (p.u < hDesc.u - 5) {
        if (/^\d+$/.test(p.s)) { cur = { desc: '', qtd: 1, valor: '' }; out.itens.push(cur); }
        continue;
      }
      if (!cur) { cur = { desc: '', qtd: 1, valor: '' }; out.itens.push(cur); }
      if (p.u < hQtd.u - 5) cur.desc = (cur.desc + ' ' + p.s).trim();
      else if (!hVal || p.u < hVal.u - 5) { const q = parseFloat(p.s.replace(',', '.')); if (!isNaN(q)) cur.qtd = q; }
      else cur.valor = p.s;
    }
  }
  return out;
}

// Junta páginas da mesma DACE (folha 1/2, 2/2...)
export function mergeDaces(pages) {
  const byKey = new Map(); const list = [];
  for (const d of pages) {
    const k = d.chave || (d.numero ? 'n' + d.numero : 'p' + list.length);
    if (byKey.has(k)) { byKey.get(k).itens.push(...d.itens); continue; }
    byKey.set(k, d); list.push(d);
  }
  return list;
}

// ---------- Lista de empacotamento (checklist de carregamento) ----------
export function parsePackingPage(pts) {
  const ids = pts.filter(p => /^ID\s*Pedido/i.test(p.s));
  const blocks = ids.map(h => ({ u: h.u, v: h.v, pedido: '', header: null, itens: [], pts: [] }));
  if (!blocks.length) return [];
  for (const p of pts) {
    const cands = blocks.filter(b => p.u >= b.u - 30 && p.v >= b.v - 45);
    if (!cands.length) continue;
    cands.sort((a, b) => (Math.round(b.u / 10) - Math.round(a.u / 10)) || (b.v - a.v));
    cands[0].pts.push(p);
  }
  for (const b of blocks) {
    const ps = b.pts;
    const idLine = ps.filter(p => Math.abs(p.v - b.v) < 3).map(p => p.s).join(' ');
    const m = idLine.match(/\b(\d{6}[0-9A-Z]{8})\b/);
    b.pedido = m ? m[1] : '';
    const hP = ps.find(p => /^Produto$/i.test(p.s));
    const hV = ps.find(p => /^Varia/i.test(p.s));
    const hQ = ps.find(p => /^Qn?t/i.test(p.s));
    const hS = ps.find(p => /^SKU$/i.test(p.s));
    if (!hP) continue;
    const rows = ps.filter(p => p.v > hP.v + 2 && !/Corte aqui|Checklist|Aten[cç][aã]o|Seu uso/i.test(p.s))
      .sort((a, b) => a.v - b.v || a.u - b.u);
    let cur = null;
    for (const p of rows) {
      if (p.u < hP.u - 3) {
        if (/^\d+$/.test(p.s)) { cur = { produto: '', variacao: '', qtd: 1, sku: '' }; b.itens.push(cur); }
        continue;
      }
      if (!cur) { cur = { produto: '', variacao: '', qtd: 1, sku: '' }; b.itens.push(cur); }
      if (!hV || p.u < hV.u - 3) cur.produto = (cur.produto + ' ' + p.s).trim();
      else if (!hQ || p.u < hQ.u - 3) cur.variacao = (cur.variacao + ' ' + p.s).trim();
      else if (!hS || p.u < hS.u - 3) { const q = parseFloat(p.s); if (!isNaN(q)) cur.qtd = q; }
      else cur.sku = (cur.sku + ' ' + p.s).trim();
    }
    delete b.pts;
  }
  return blocks.filter(b => b.itens.length);
}

// ---------- casamento DACE x lista ----------
export function sameProduct(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.startsWith(y) || y.startsWith(x)) return true;
  const A = new Set(x.split(' ')), B = new Set(y.split(' '));
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / Math.max(A.size, B.size) >= 0.85;
}

function blockMatches(itens, block) {
  if (itens.length !== block.itens.length) return false;
  const used = new Set();
  for (const it of itens) {
    const j = block.itens.findIndex((bi, k) => !used.has(k) && sameProduct(it.desc, bi.produto) && bi.qtd === it.qtd);
    if (j < 0) return false;
    used.add(j);
  }
  return true;
}

// Para cada etiqueta (lista de itens da DACE) acha o bloco da lista de
// empacotamento. Retorna {block, ambiguous, variacoes} por etiqueta.
export function matchPacking(labelItens, blocks) {
  const usedBlocks = new Set();
  const res = labelItens.map(() => null);
  // 1ª passada: casamentos únicos
  const cands = labelItens.map(itens => itens && itens.length ? blocks.map((b, i) => blockMatches(itens, b) ? i : -1).filter(i => i >= 0) : []);
  cands.forEach((c, i) => { if (c.length === 1) { res[i] = { block: blocks[c[0]], ambiguous: false }; usedBlocks.add(c[0]); } });
  // 2ª passada: vários pedidos com o mesmo produto
  cands.forEach((c, i) => {
    if (res[i] || !c.length) return;
    const free = c.filter(k => !usedBlocks.has(k));
    const pool = free.length ? free : c;
    const sig = k => blocks[k].itens.map(x => norm(x.produto) + '|' + norm(x.variacao)).sort().join('#');
    const same = pool.every(k => sig(k) === sig(pool[0]));
    usedBlocks.add(pool[0]);
    res[i] = {
      block: blocks[pool[0]],
      ambiguous: true,
      sameVariation: same,
      variacoes: [...new Set(pool.flatMap(k => blocks[k].itens.map(x => x.variacao).filter(Boolean)))],
    };
  });
  return res;
}
