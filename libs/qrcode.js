/**
 * QR code renderer — browser build
 * Based on node-qrcode@1.5.1. Byte mode, EC level L only.
 */
var QRCode = function(t) {
  "use strict";

  // Total codewords per version (index = version)
  var cw = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706],
    i = function(t) {
      for (var r = 0; 0 !== t;) r++, t >>>= 1;
      return r
    };

  var ECL = { bit: 1 };

  // ── BitMatrix ──────────────────────────────────────────────────────────────
  function l(t) {
    if (!t || t < 1) throw new Error("BitMatrix size must be defined and greater than 0");
    this.size = t, this.data = new Uint8Array(t * t), this.reservedBit = new Uint8Array(t * t)
  }
  l.prototype.set = function(t, r, e, n) {
    var o = t * this.size + r;
    this.data[o] = e, n && (this.reservedBit[o] = !0)
  };
  l.prototype.get = function(t, r) { return this.data[t * this.size + r] };
  l.prototype.xor = function(t, r, e) { this.data[t * this.size + r] ^= e };
  l.prototype.isReserved = function(t, r) { return this.reservedBit[t * this.size + r] };

  // ── Alignment pattern positions ────────────────────────────────────────────
  function alignmentPositions(version) {
    if (version === 1) return [];
    var cnt = Math.floor(version / 7) + 2, sz = 4 * version + 17;
    var step = sz === 145 ? 26 : 2 * Math.ceil((sz - 13) / (2 * cnt - 2));
    var coords = [sz - 7];
    for (var k = 1; k < cnt - 1; k++) coords[k] = coords[k - 1] - step;
    coords.push(6);
    coords.reverse();
    var len = coords.length, out = [];
    for (var a = 0; a < len; a++)
      for (var b = 0; b < len; b++)
        if (!(a === 0 && b === 0) && !(a === 0 && b === len - 1) && !(a === len - 1 && b === 0))
          out.push([coords[a], coords[b]]);
    return out;
  }

  // ── Mask patterns + penalty scoring ───────────────────────────────────────
  function maskBit(t, row, col) {
    switch (t) {
      case 0: return (row + col) % 2 == 0;
      case 1: return row % 2 == 0;
      case 2: return col % 3 == 0;
      case 3: return (row + col) % 3 == 0;
      case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 == 0;
      case 5: return row * col % 2 + row * col % 3 == 0;
      case 6: return (row * col % 2 + row * col % 3) % 2 == 0;
      case 7: return (row * col % 3 + (row + col) % 2) % 2 == 0;
      default: throw new Error("bad maskPattern:" + t)
    }
  }

  var E = {
    getPenaltyN1: function(t) {
      for (var r = t.size, n = 0, o = 0, a = 0, i = null, u = null, s = 0; s < r; s++) {
        o = a = 0, i = u = null;
        for (var f = 0; f < r; f++) {
          var h = t.get(s, f);
          h === i ? o++ : (o >= 5 && (n += 3 + (o - 5)), i = h, o = 1);
          (h = t.get(f, s)) === u ? a++ : (a >= 5 && (n += 3 + (a - 5)), u = h, a = 1)
        }
        o >= 5 && (n += 3 + (o - 5)), a >= 5 && (n += 3 + (a - 5))
      }
      return n
    },
    getPenaltyN2: function(t) {
      for (var r = t.size, e = 0, o = 0; o < r - 1; o++)
        for (var a = 0; a < r - 1; a++) {
          var i = t.get(o, a) + t.get(o, a + 1) + t.get(o + 1, a) + t.get(o + 1, a + 1);
          4 !== i && 0 !== i || e++
        }
      return e * 3
    },
    getPenaltyN3: function(t) {
      for (var r = t.size, e = 0, n = 0, a = 0, i = 0; i < r; i++) {
        n = a = 0;
        for (var u = 0; u < r; u++) {
          n = n << 1 & 2047 | t.get(i, u), u >= 10 && (1488 === n || 93 === n) && e++;
          a = a << 1 & 2047 | t.get(u, i), u >= 10 && (1488 === a || 93 === a) && e++
        }
      }
      return e * 40
    },
    getPenaltyN4: function(t) {
      for (var r = 0, e = t.data.length, n = 0; n < e; n++) r += t.data[n];
      return Math.abs(Math.ceil(100 * r / e / 5) - 10) * 10
    },
    applyMask: function(t, r) {
      for (var e = r.size, n = 0; n < e; n++)
        for (var o = 0; o < e; o++) r.isReserved(o, n) || r.xor(o, n, maskBit(t, o, n))
    },
    getBestMask: function(t, e) {
      for (var o = 0, a = Infinity, i = 0; i < 8; i++) {
        e(i), E.applyMask(i, t);
        var u = E.getPenaltyN1(t) + E.getPenaltyN2(t) + E.getPenaltyN3(t) + E.getPenaltyN4(t);
        E.applyMask(i, t), u < a && (a = u, o = i)
      }
      return o
    }
  };

  // ── EC block/codeword counts (L only) ─────────────────────────────────────
  var y = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    A = [7, 10, 15, 20, 26, 36, 40, 48, 60, 72, 80, 96, 104, 120, 132, 144, 168, 180, 196, 224, 224, 252, 270, 300, 312, 336, 360, 390, 420, 450, 480, 510, 540, 570, 570, 600, 630, 660, 720, 750],
    I = function(t) { return y[t - 1] },
    M = function(t) { return A[t - 1] };

  // ── GF(256) tables ─────────────────────────────────────────────────────────
  var N = new Uint8Array(512), B = new Uint8Array(256);
  !function() {
    for (var t = 1, r = 0; r < 255; r++) N[r] = t, B[t] = r, 256 & (t <<= 1) && (t ^= 285);
    for (var e = 255; e < 512; e++) N[e] = N[e - 255]
  }();
  var C = function(t) { return N[t] },
    P = function(t, r) { return 0 === t || 0 === r ? 0 : N[B[t] + B[r]] };

  // ── Polynomial operations ──────────────────────────────────────────────────
  var R = {};
  R.mul = function(t, r) {
    for (var e = new Uint8Array(t.length + r.length - 1), n = 0; n < t.length; n++)
      for (var o = 0; o < r.length; o++) e[n + o] ^= P(t[n], r[o]);
    return e
  };
  R.mod = function(t, r) {
    for (var e = new Uint8Array(t); e.length - r.length >= 0;) {
      for (var n = e[0], o = 0; o < r.length; o++) e[o] ^= P(r[o], n);
      for (var a = 0; a < e.length && 0 === e[a];) a++;
      e = e.slice(a)
    }
    return e
  };
  R.generateECPolynomial = function(t) {
    for (var e = new Uint8Array([1]), n = 0; n < t; n++) e = R.mul(e, new Uint8Array([1, C(n)]));
    return e
  };

  // ── Reed-Solomon encoder ───────────────────────────────────────────────────
  function T(t) {
    this.degree = t, this.genPoly = R.generateECPolynomial(t)
  }
  T.prototype.encode = function(t) {
    var r = new Uint8Array(t.length + this.degree);
    r.set(t);
    var e = R.mod(r, this.genPoly), n = this.degree - e.length;
    if (n > 0) { var o = new Uint8Array(this.degree); return o.set(e, n), o }
    return e
  };

  // ── Version and format ─────────────────────────────────────────────────────
  var O = {};
  O.getCapacity = function(t) {
    return Math.floor((8 * (cw[t] - M(t)) - (t < 10 ? 12 : 20)) / 8)
  };
  O.getBestVersionForData = function(len) {
    for (var o = 1; o <= 40; o++) if (len <= O.getCapacity(o)) return o
  };
  var _versionBits = 13; // precomputed i(7973)
  O.getEncodedBits = function(t) {
    if (t < 7) throw new Error("Invalid QR Code version");
    for (var r = t << 12; i(r) - _versionBits >= 0;) r ^= 7973 << i(r) - _versionBits;
    return t << 12 | r
  };

  // ── Format info ────────────────────────────────────────────────────────────
  var Q = 11, // precomputed i(1335)
    V = function(t, r) {
      for (var e = t.bit << 3 | r, n = e << 10; i(n) - Q >= 0;) n ^= 1335 << i(n) - Q;
      return 21522 ^ (e << 10 | n)
    };

  // ── Format info writer ─────────────────────────────────────────────────────
  function ot(t, r, e) {
    var n, o, a = t.size, i = V(r, e);
    for (n = 0; n < 15; n++) {
      o = 1 == (i >> n & 1);
      n < 6 ? t.set(n, 8, o, !0) : n < 8 ? t.set(n + 1, 8, o, !0) : t.set(a - 15 + n, 8, o, !0);
      n < 8 ? t.set(8, a - n - 1, o, !0) : n < 9 ? t.set(8, 15 - n - 1 + 1, o, !0) : t.set(8, 15 - n - 1, o, !0)
    }
    t.set(a - 8, 8, 1, !0)
  }

  // ── Data encoder: byte-mode bit packing + RS interleaving ─────────────────
  function at(version, data) {
    var totalBytes = cw[version] - M(version);
    var ccBits = version < 10 ? 8 : 16;
    var buf = new Uint8Array(totalBytes);
    var bits = 0, blen = 0, idx = 0;
    function push(val, n) {
      bits = bits << n | val; blen += n;
      while (blen >= 8) { blen -= 8; buf[idx++] = bits >> blen & 0xFF; }
    }
    push(4, 4);                // byte mode indicator
    push(data.length, ccBits); // character count
    for (var k = 0; k < data.length; k++) push(data[k], 8);
    push(0, Math.min(4, totalBytes * 8 - 4 - ccBits - 8 * data.length)); // terminator
    if (blen) buf[idx++] = bits << (8 - blen) & 0xFF;
    for (var pad = 0; idx < totalBytes; idx++, pad++) buf[idx] = pad & 1 ? 0x11 : 0xEC;

    var total = cw[version], numBlocks = I(version);
    var shortBlocks = numBlocks - total % numBlocks;
    var shortData = Math.floor(totalBytes / numBlocks);
    var ecPerBlock = Math.floor(total / numBlocks) - shortData;
    var rs = new T(ecPerBlock), off = 0, maxLen = 0;
    var dataBlocks = new Array(numBlocks), ecBlocks = new Array(numBlocks);
    for (var b = 0; b < numBlocks; b++) {
      var len = b < shortBlocks ? shortData : shortData + 1;
      dataBlocks[b] = buf.slice(off, off + len);
      ecBlocks[b] = rs.encode(dataBlocks[b]);
      off += len; maxLen = Math.max(maxLen, len);
    }
    var out = new Uint8Array(total), pos = 0;
    for (var ii = 0; ii < maxLen; ii++)
      for (var jj = 0; jj < numBlocks; jj++)
        if (ii < dataBlocks[jj].length) out[pos++] = dataBlocks[jj][ii];
    for (var ii = 0; ii < ecPerBlock; ii++)
      for (var jj = 0; jj < numBlocks; jj++)
        out[pos++] = ecBlocks[jj][ii];
    return out;
  }

  // ── QR code builder ───────────────────────────────────────────────────────
  function it(t, r, n) {
    var data = t[0] && t[0].data ? t[0].data : new Uint8Array(0);
    var version = r || O.getBestVersionForData(data.length);
    if (!version) throw new Error("The amount of data is too big to be stored in a QR Code");
    var sz = 4 * version + 17, mat = new l(sz);
    var encoded = at(version, data);

    // Finder patterns
    var fpos = [[0, 0], [sz - 7, 0], [0, sz - 7]];
    for (var fp = 0; fp < 3; fp++) {
      var fr = fpos[fp][0], fc = fpos[fp][1];
      for (var fu = -1; fu <= 7; fu++) {
        if (fr + fu < 0 || fr + fu >= sz) continue;
        for (var fs = -1; fs <= 7; fs++) {
          if (fc + fs < 0 || fc + fs >= sz) continue;
          mat.set(fr + fu, fc + fs,
            fu >= 0 && fu <= 6 && (fs === 0 || fs === 6) ||
            fs >= 0 && fs <= 6 && (fu === 0 || fu === 6) ||
            fu >= 2 && fu <= 4 && fs >= 2 && fs <= 4, !0);
        }
      }
    }

    // Timing patterns
    for (var te = 8; te < sz - 8; te++) {
      mat.set(te, 6, te % 2 == 0, !0); mat.set(6, te, te % 2 == 0, !0);
    }

    // Alignment patterns
    var apos = alignmentPositions(version);
    for (var ap = 0; ap < apos.length; ap++) {
      var ar = apos[ap][0], ac = apos[ap][1];
      for (var ai = -2; ai <= 2; ai++)
        for (var aj = -2; aj <= 2; aj++)
          mat.set(ar + ai, ac + aj,
            ai === -2 || ai === 2 || aj === -2 || aj === 2 || (ai === 0 && aj === 0), !0);
    }

    ot(mat, ECL, 0);

    // Version info (version >= 7 only)
    if (version >= 7) {
      var vbits = O.getEncodedBits(version);
      for (var vi = 0; vi < 18; vi++) {
        var vr = Math.floor(vi / 3), vc = vi % 3 + sz - 11, vb = !!(vbits >> vi & 1);
        mat.set(vr, vc, vb, !0); mat.set(vc, vr, vb, !0);
      }
    }

    // Data placement
    var dir = -1, row = sz - 1, bit = 7, didx = 0;
    for (var col = sz - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (;;) {
        for (var ds = 0; ds < 2; ds++) {
          if (!mat.isReserved(row, col - ds)) {
            var dv = didx < encoded.length ? encoded[didx] >>> bit & 1 : 0;
            mat.set(row, col - ds, dv);
            if (--bit < 0) { didx++; bit = 7; }
          }
        }
        if ((row += dir) < 0 || row >= sz) { row -= dir; dir = -dir; break; }
      }
    }

    var maskPat = isNaN(n) ? E.getBestMask(mat, ot.bind(null, mat, ECL)) : n;
    E.applyMask(maskPat, mat);
    ot(mat, ECL, maskPat);
    return mat;
  }

  // ── Canvas renderer ───────────────────────────────────────────────────────
  t.toCanvas = function(r, n, o) {
    return new Promise(function(e, a) {
      try {
        var mat = it(n, void 0, void 0);
        o || (o = {});
        var margin = void 0 === o.margin || null === o.margin || o.margin < 0 ? 4 : o.margin;
        var w = o.width && o.width >= 21 ? o.width : void 0;
        var scale = w ? w / (mat.size + 2 * margin) : (o.scale || 4);
        var size = Math.floor((mat.size + 2 * margin) * scale);
        var ctx = r.getContext("2d");
        var img = ctx.createImageData(size, size), px = img.data;
        var s = margin * scale;
        for (var h = 0; h < size; h++)
          for (var c = 0; c < size; c++) {
            var g = 4 * (h * size + c);
            var dark = h >= s && c >= s && h < size - s && c < size - s &&
              mat.data[Math.floor((h - s) / scale) * mat.size + Math.floor((c - s) / scale)];
            var v = dark ? 0 : 255;
            px[g++] = v, px[g++] = v, px[g++] = v, px[g] = 255;
          }
        ctx.clearRect(0, 0, r.width, r.height);
        r.height = size, r.width = size;
        r.style.height = size + "px", r.style.width = size + "px";
        ctx.putImageData(img, 0, 0);
        e(r)
      } catch (t) { a(t) }
    })
  };
  return t
}({});
