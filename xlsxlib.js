/* xlsxlib.js — leitor/escritor mínimo de .xlsx (ZIP + DEFLATE) em JS puro, sem dependências.
   Fornece: MiniXLSX.read(arrayBuffer) -> {sheetName: [[c1,c2,...], ...], ...}
            MiniXLSX.write({sheetName: [[c1,c2,...], ...], ...}) -> Uint8Array (.xlsx)
   Suporta leitura de arquivos ZIP com métodos STORED (0) e DEFLATE (8).
   Escrita sempre em STORED (sem compressão) — válido e aberto normalmente pelo Excel. */
(function (global) {
  "use strict";

  // ---------- CRC32 ----------
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------- INFLATE (RFC1951 raw deflate) ----------
  const LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  const CLC_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

  function BitReader(bytes) {
    this.b = bytes; this.pos = 0; this.bitpos = 0;
  }
  BitReader.prototype.bit = function () {
    const byte = this.b[this.pos];
    const bit = (byte >>> this.bitpos) & 1;
    this.bitpos++;
    if (this.bitpos === 8) { this.bitpos = 0; this.pos++; }
    return bit;
  };
  BitReader.prototype.bits = function (n) {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.bit() << i;
    return v;
  };

  function buildHuffman(lengths) {
    const maxBits = Math.max.apply(null, lengths);
    const blCount = new Array(maxBits + 1).fill(0);
    for (const l of lengths) if (l > 0) blCount[l]++;
    const nextCode = new Array(maxBits + 1).fill(0);
    let code = 0;
    for (let bits = 1; bits <= maxBits; bits++) {
      code = (code + blCount[bits - 1]) << 1;
      nextCode[bits] = code;
    }
    const codes = new Array(lengths.length).fill(0);
    for (let n = 0; n < lengths.length; n++) {
      const len = lengths[n];
      if (len > 0) { codes[n] = nextCode[len]; nextCode[len]++; }
    }
    // map from "len:code" string to symbol for decode
    const map = new Map();
    for (let n = 0; n < lengths.length; n++) {
      if (lengths[n] > 0) map.set(lengths[n] + ':' + codes[n], n);
    }
    return { map, maxBits };
  }
  function decodeSymbol(br, huff) {
    let code = 0, len = 0;
    while (len < huff.maxBits) {
      code = (code << 1) | br.bit();
      len++;
      const sym = huff.map.get(len + ':' + code);
      if (sym !== undefined) return sym;
    }
    throw new Error('inflate: código Huffman inválido');
  }

  function inflateRaw(data) {
    const br = new BitReader(data);
    const out = [];
    let final = 0;
    while (!final) {
      final = br.bit();
      const type = br.bits(2);
      if (type === 0) {
        // stored
        if (br.bitpos !== 0) { br.bitpos = 0; br.pos++; }
        const len = data[br.pos] | (data[br.pos + 1] << 8);
        br.pos += 4;
        for (let i = 0; i < len; i++) out.push(data[br.pos++]);
      } else if (type === 1 || type === 2) {
        let litHuff, distHuff;
        if (type === 1) {
          const litLens = new Array(288);
          for (let i = 0; i <= 143; i++) litLens[i] = 8;
          for (let i = 144; i <= 255; i++) litLens[i] = 9;
          for (let i = 256; i <= 279; i++) litLens[i] = 7;
          for (let i = 280; i <= 287; i++) litLens[i] = 8;
          const distLens = new Array(30).fill(5);
          litHuff = buildHuffman(litLens);
          distHuff = buildHuffman(distLens);
        } else {
          const hlit = br.bits(5) + 257;
          const hdist = br.bits(5) + 1;
          const hclen = br.bits(4) + 4;
          const clcLens = new Array(19).fill(0);
          for (let i = 0; i < hclen; i++) clcLens[CLC_ORDER[i]] = br.bits(3);
          const clcHuff = buildHuffman(clcLens);
          const allLens = [];
          while (allLens.length < hlit + hdist) {
            const sym = decodeSymbol(br, clcHuff);
            if (sym < 16) allLens.push(sym);
            else if (sym === 16) { const rep = br.bits(2) + 3; const prev = allLens[allLens.length - 1]; for (let i=0;i<rep;i++) allLens.push(prev); }
            else if (sym === 17) { const rep = br.bits(3) + 3; for (let i=0;i<rep;i++) allLens.push(0); }
            else { const rep = br.bits(7) + 11; for (let i=0;i<rep;i++) allLens.push(0); }
          }
          litHuff = buildHuffman(allLens.slice(0, hlit));
          distHuff = buildHuffman(allLens.slice(hlit));
        }
        while (true) {
          const sym = decodeSymbol(br, litHuff);
          if (sym < 256) out.push(sym);
          else if (sym === 256) break;
          else {
            const idx = sym - 257;
            const len = LEN_BASE[idx] + br.bits(LEN_EXTRA[idx]);
            const dsym = decodeSymbol(br, distHuff);
            const dist = DIST_BASE[dsym] + br.bits(DIST_EXTRA[dsym]);
            let start = out.length - dist;
            for (let i = 0; i < len; i++) out.push(out[start + i]);
          }
        }
      } else {
        throw new Error('inflate: tipo de bloco inválido');
      }
    }
    return new Uint8Array(out);
  }

  // ---------- ZIP reader ----------
  function readZip(buf) {
    const dv = new DataView(buf);
    const bytes = new Uint8Array(buf);
    // find End Of Central Directory
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('Arquivo .xlsx inválido (EOCD não encontrado)');
    const cdOffset = dv.getUint32(eocd + 16, true);
    const cdEntries = dv.getUint16(eocd + 10, true);
    const files = {};
    let p = cdOffset;
    for (let e = 0; e < cdEntries; e++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      // read local header to find actual data offset (name/extra lengths can differ)
      const lNameLen = dv.getUint16(localOffset + 26, true);
      const lExtraLen = dv.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(dataStart, dataStart + compSize);
      let content;
      if (method === 0) content = raw;
      else if (method === 8) content = inflateRaw(raw);
      else throw new Error('Método de compressão não suportado: ' + method);
      files[name] = content;
      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  // ---------- ZIP writer (STORED only) ----------
  function writeZip(fileMap) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

    for (const name in fileMap) {
      const data = typeof fileMap[name] === 'string' ? encoder.encode(fileMap[name]) : fileMap[name];
      const nameBytes = encoder.encode(name);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const ldv = new DataView(local.buffer);
      ldv.setUint32(0, 0x04034b50, true);
      ldv.setUint16(4, 20, true);   // version needed
      ldv.setUint16(6, 0, true);    // flags
      ldv.setUint16(8, 0, true);    // method = stored
      ldv.setUint16(10, dosTime, true);
      ldv.setUint16(12, dosDate, true);
      ldv.setUint32(14, crc, true);
      ldv.setUint32(18, data.length, true); // compressed size
      ldv.setUint32(22, data.length, true); // uncompressed size
      ldv.setUint16(26, nameBytes.length, true);
      ldv.setUint16(28, 0, true); // extra len
      local.set(nameBytes, 30);
      parts.push(local, data);

      const centralEntry = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(centralEntry.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(4, 20, true);
      cdv.setUint16(6, 20, true);
      cdv.setUint16(8, 0, true);
      cdv.setUint16(10, 0, true);
      cdv.setUint16(12, dosTime, true);
      cdv.setUint16(14, dosDate, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, data.length, true);
      cdv.setUint32(24, data.length, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint16(30, 0, true);
      cdv.setUint16(32, 0, true);
      cdv.setUint16(34, 0, true);
      cdv.setUint16(36, 0, true);
      cdv.setUint32(38, 0, true);
      cdv.setUint32(42, offset, true);
      centralEntry.set(nameBytes, 46);
      central.push(centralEntry);

      offset += local.length + data.length;
    }
    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) centralSize += c.length;

    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(4, 0, true);
    edv.setUint16(6, 0, true);
    edv.setUint16(8, central.length, true);
    edv.setUint16(10, central.length, true);
    edv.setUint32(12, centralSize, true);
    edv.setUint32(16, centralStart, true);
    edv.setUint16(20, 0, true);

    const all = parts.concat(central, [eocd]);
    let total = 0;
    for (const a of all) total += a.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const a of all) { out.set(a, pos); pos += a.length; }
    return out;
  }

  // ---------- XML helpers ----------
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function parseTag(xml, tag) {
    const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'g');
    const out = [];
    let m;
    while ((m = re.exec(xml))) out.push(m[1]);
    return out;
  }
  function unescapeXml(s) {
    return s
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }
  function attr(tagXml, name) {
    const m = new RegExp(name + '="([^"]*)"').exec(tagXml);
    return m ? m[1] : null;
  }

  // ---------- XLSX write ----------
  function colName(idx) {
    let s = '';
    idx++;
    while (idx > 0) { const r = (idx - 1) % 26; s = String.fromCharCode(65 + r) + s; idx = Math.floor((idx - 1) / 26); }
    return s;
  }

  function write(sheets) {
    const sheetNames = Object.keys(sheets);
    const files = {};
    files['[Content_Types].xml'] =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheetNames.map((n, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
      '</Types>';
    files['_rels/.rels'] =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';
    files['xl/workbook.xml'] =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + sheetNames.map((n, i) => '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets>' +
      '</workbook>';
    files['xl/_rels/workbook.xml.rels'] =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheetNames.map((n, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
      '</Relationships>';

    sheetNames.forEach((name, i) => {
      const rows = sheets[name];
      let rowsXml = '';
      rows.forEach((row, r) => {
        let cellsXml = '';
        row.forEach((val, c) => {
          const ref = colName(c) + (r + 1);
          if (val === null || val === undefined || val === '') return;
          if (typeof val === 'number' && isFinite(val)) {
            cellsXml += '<c r="' + ref + '"><v>' + val + '</v></c>';
          } else {
            cellsXml += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + esc(val) + '</t></is></c>';
          }
        });
        rowsXml += '<row r="' + (r + 1) + '">' + cellsXml + '</row>';
      });
      files['xl/worksheets/sheet' + (i + 1) + '.xml'] =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rowsXml + '</sheetData></worksheet>';
    });

    return writeZip(files);
  }

  // ---------- XLSX read ----------
  function read(buf) {
    const files = readZip(buf);
    const decoder = new TextDecoder();
    const wbXml = decoder.decode(files['xl/workbook.xml']);
    const relsXml = files['xl/_rels/workbook.xml.rels'] ? decoder.decode(files['xl/_rels/workbook.xml.rels']) : '';

    // shared strings (optional)
    let sharedStrings = [];
    if (files['xl/sharedStrings.xml']) {
      const ssXml = decoder.decode(files['xl/sharedStrings.xml']);
      const siList = parseTag(ssXml, 'si');
      sharedStrings = siList.map(si => {
        const ts = parseTag(si, 't');
        return ts.join('');
      });
    }

    // map rId -> target (atributos em arquivos reais do Excel vêm em ordem variável)
    const relMap = {};
    const relTagRe = /<Relationship\b[^>]*\/>/g;
    let rtm;
    while ((rtm = relTagRe.exec(relsXml))) {
      const tagXml = rtm[0];
      const id = attr(tagXml, 'Id');
      const target = attr(tagXml, 'Target');
      if (id && target) relMap[id] = target;
    }

    // sheet name -> rId (idem, ordem de atributos variável)
    const sheetTagRe = /<sheet\b[^>]*\/>/g;
    const result = {};
    let sm;
    while ((sm = sheetTagRe.exec(wbXml))) {
      const tagXml = sm[0];
      const sheetName = attr(tagXml, 'name');
      const rId = attr(tagXml, 'r:id');
      const target = relMap[rId];
      if (!target) continue;
      const path = 'xl/' + target.replace(/^\/?(xl\/)?/, '').replace(/^\.?\//, '');
      const sheetBytes = files[path];
      if (!sheetBytes) continue;
      const sheetXml = decoder.decode(sheetBytes);
      const rowTags = [];
      const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
      let rmatch;
      while ((rmatch = rowRe.exec(sheetXml))) rowTags.push(rmatch[1]);
      const rows = rowTags.map(rowInner => {
        const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
        const cells = [];
        let cm;
        while ((cm = cellRe.exec(rowInner))) {
          const attrs = cm[1] || cm[3] || '';
          const inner = cm[2] || '';
          const t = attr(attrs, 't');
          let value = '';
          if (t === 's') {
            const vMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
            const idx = vMatch ? parseInt(vMatch[1], 10) : -1;
            value = sharedStrings[idx] !== undefined ? sharedStrings[idx] : '';
          } else if (t === 'inlineStr') {
            const tMatch = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
            value = tMatch ? tMatch[1] : '';
          } else {
            const vMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
            value = vMatch ? vMatch[1] : '';
            if (value !== '' && !isNaN(value)) value = parseFloat(value);
          }
          value = typeof value === 'string' ? unescapeXml(value) : value;
          cells.push(value);
        }
        return cells;
      });
      result[sheetName] = rows;
    }
    return result;
  }

  global.MiniXLSX = { read, write, _inflateRaw: inflateRaw, _crc32: crc32 };
})(typeof window !== 'undefined' ? window : global);
