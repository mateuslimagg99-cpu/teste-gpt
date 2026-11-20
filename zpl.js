// Leitura e escrita das imagens (~DG / ^GF) dentro de um arquivo ZPL.

const b64ToBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function streamBytes(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const inflate = b => streamBytes(b, new DecompressionStream('deflate'));
const deflate = b => streamBytes(b, new CompressionStream('deflate'));

// CRC-16/XMODEM usado pela Zebra no :Z64:
export function crc16(str) {
  let c = 0;
  for (let i = 0; i < str.length; i++) {
    c ^= str.charCodeAt(i) << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}

// Hex ASCII com a compressão de repetição da ZPL (G-Y, g-z, ',', '!', ':')
function decodeHexZpl(str, total, bpr) {
  const out = new Uint8Array(total);
  const rowHex = bpr * 2;
  let row = '', prev = '0'.repeat(rowHex), pos = 0, i = 0;
  const flush = () => {
    row = row.padEnd(rowHex, '0').slice(0, rowHex);
    for (let k = 0; k < bpr && pos < total; k++) out[pos++] = parseInt(row.substr(k * 2, 2), 16);
    prev = row; row = '';
  };
  while (i < str.length && pos < total) {
    let count = 0, c = str[i];
    while (c && /[G-Yg-z]/.test(c)) {
      count += c <= 'Y' ? c.charCodeAt(0) - 70 : (c.charCodeAt(0) - 102) * 20;
      c = str[++i];
    }
    if (!c) break;
    i++;
    if (c === ',') { row = row.padEnd(rowHex, '0'); flush(); continue; }
    if (c === '!') { row = row.padEnd(rowHex, 'F'); flush(); continue; }
    if (c === ':') { row = prev; flush(); continue; }
    if (!/[0-9A-Fa-f]/.test(c)) continue;
    row += c.repeat(count || 1);
    while (row.length >= rowHex) { const rest = row.slice(rowHex); row = row.slice(0, rowHex); flush(); row = rest; }
  }
  if (row.length) flush();
  return out;
}

async function decodeData(data, total, bpr) {
  data = data.replace(/\s+/g, '');
  let bytes;
  if (/^:Z64:/i.test(data)) bytes = await inflate(b64ToBytes(data.split(':')[2]));
  else if (/^:B64:/i.test(data)) bytes = b64ToBytes(data.split(':')[2]);
  else bytes = decodeHexZpl(data, total, bpr);
  if (bytes.length < total) { const b = new Uint8Array(total); b.set(bytes); bytes = b; }
  return bytes.subarray(0, total);
}

const RE_DG = /~DG([^,]*),(\d+),(\d+),([^\^~]*)/g;
const RE_GF = /\^GF[A],(\d+),(\d+),(\d+),([^\^~]*)/g;

// Divide o arquivo em "unidades" (uma etiqueta cada) e decodifica a imagem.
export async function parseZpl(text) {
  const found = [];
  for (const m of text.matchAll(RE_DG)) found.push({ kind: 'DG', index: m.index, len: m[0].length, name: m[1], total: +m[2], bpr: +m[3], data: m[4] });
  for (const m of text.matchAll(RE_GF)) found.push({ kind: 'GF', index: m.index, len: m[0].length, name: '', total: +m[2], bpr: +m[3], data: m[4] });
  found.sort((a, b) => a.index - b.index);
  const graphics = found.filter(g => g.total > 2000); // ignora logos pequenos
  const starts = graphics.map(g => g.kind === 'DG' ? g.index : Math.max(0, text.lastIndexOf('^XA', g.index)));
  const prefix = graphics.length ? text.slice(0, starts[0]) : text;
  const units = [];
  for (let i = 0; i < graphics.length; i++) {
    const g = graphics[i];
    const start = starts[i], end = i + 1 < graphics.length ? starts[i + 1] : text.length;
    const bits = await decodeData(g.data, g.total, g.bpr);
    units.push({
      kind: g.kind, name: g.name, bpr: g.bpr, total: g.total,
      width: g.bpr * 8, height: Math.floor(g.total / g.bpr), bits,
      before: text.slice(start, g.index), after: text.slice(g.index + g.len, end),
    });
  }
  return { prefix, units };
}

// Monta o texto de uma unidade com uma nova imagem (bits 1 = preto).
export async function encodeUnit(unit, bits) {
  const b64 = bytesToB64(await deflate(bits));
  const data = `:Z64:${b64}:${crc16(b64)}`;
  const g = unit.kind === 'DG'
    ? `~DG${unit.name},${unit.total},${unit.bpr},${data}`
    : `^GFA,${unit.total},${unit.total},${unit.bpr},${data}`;
  return unit.before + g + unit.after;
}
