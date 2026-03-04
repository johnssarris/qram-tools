/**
 * QR code renderer — browser build
 * Based on node-qrcode@1.5.1. Byte mode, EC level L only.
 */
var QRCode = function(t) {
  "use strict";

  // Total codewords per version (index = version)
  var cw = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706],
    o = function(t) {
      if (!t) throw new Error('"version" cannot be null or undefined');
      if (t < 1 || t > 40) throw new Error('"version" should be in range from 1 to 40');
      return 4 * t + 17
    },
    i = function(t) {
      for (var r = 0; 0 !== t;) r++, t >>>= 1;
      return r
    };

  var c = { L: { bit: 1 } };

  // ── BitBuffer ──────────────────────────────────────────────────────────────
  function g() { this.buffer = [], this.length = 0 }
  g.prototype = {
    get: function(t) { return 1 == (this.buffer[Math.floor(t / 8)] >>> 7 - t % 8 & 1) },
    put: function(t, r) { for (var e = 0; e < r; e++) this.putBit(1 == (t >>> r - e - 1 & 1)) },
    getLengthInBits: function() { return this.length },
    putBit: function(t) {
      var r = Math.floor(this.length / 8);
      this.buffer.length <= r && this.buffer.push(0), t && (this.buffer[r] |= 128 >>> this.length % 8), this.length++
    }
  };

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

  // ── Alignment patterns ─────────────────────────────────────────────────────
  var p = {
    getRowColCoords: function(t) {
      if (1 === t) return [];
      var r = Math.floor(t / 7) + 2, sz = o(t);
      var step = 145 === sz ? 26 : 2 * Math.ceil((sz - 13) / (2 * r - 2));
      for (var a = [sz - 7], i = 1; i < r - 1; i++) a[i] = a[i - 1] - step;
      return a.push(6), a.reverse()
    },
    getPositions: function(t) {
      for (var e = [], n = p.getRowColCoords(t), o = n.length, a = 0; a < o; a++)
        for (var i = 0; i < o; i++)
          0 === a && 0 === i || 0 === a && i === o - 1 || a === o - 1 && 0 === i || e.push([n[a], n[i]]);
      return e
    }
  };

  // ── Finder pattern positions ───────────────────────────────────────────────
  var m = function(t) {
    var r = o(t);
    return [[0, 0], [r - 7, 0], [0, r - 7]]
  };

  // ── Mask patterns + penalty scoring ───────────────────────────────────────
  var E = (function() {
    var p1 = 3, p2 = 3, p3 = 40, p4 = 10;

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

    var r = {
      getPenaltyN1: function(t) {
        for (var r = t.size, n = 0, o = 0, a = 0, i = null, u = null, s = 0; s < r; s++) {
          o = a = 0, i = u = null;
          for (var f = 0; f < r; f++) {
            var h = t.get(s, f);
            h === i ? o++ : (o >= 5 && (n += p1 + (o - 5)), i = h, o = 1);
            (h = t.get(f, s)) === u ? a++ : (a >= 5 && (n += p1 + (a - 5)), u = h, a = 1)
          }
          o >= 5 && (n += p1 + (o - 5)), a >= 5 && (n += p1 + (a - 5))
        }
        return n
      },
      getPenaltyN2: function(t) {
        for (var r = t.size, e = 0, o = 0; o < r - 1; o++)
          for (var a = 0; a < r - 1; a++) {
            var i = t.get(o, a) + t.get(o, a + 1) + t.get(o + 1, a) + t.get(o + 1, a + 1);
            4 !== i && 0 !== i || e++
          }
        return e * p2
      },
      getPenaltyN3: function(t) {
        for (var r = t.size, e = 0, n = 0, a = 0, i = 0; i < r; i++) {
          n = a = 0;
          for (var u = 0; u < r; u++) {
            n = n << 1 & 2047 | t.get(i, u), u >= 10 && (1488 === n || 93 === n) && e++;
            a = a << 1 & 2047 | t.get(u, i), u >= 10 && (1488 === a || 93 === a) && e++
          }
        }
        return e * p3
      },
      getPenaltyN4: function(t) {
        for (var r = 0, e = t.data.length, n = 0; n < e; n++) r += t.data[n];
        return Math.abs(Math.ceil(100 * r / e / 5) - 10) * p4
      },
      applyMask: function(t, r) {
        for (var e = r.size, n = 0; n < e; n++)
          for (var o = 0; o < e; o++) r.isReserved(o, n) || r.xor(o, n, maskBit(t, o, n))
      },
      getBestMask: function(t, e) {
        for (var o = 0, a = Infinity, i = 0; i < 8; i++) {
          e(i), r.applyMask(i, t);
          var u = r.getPenaltyN1(t) + r.getPenaltyN2(t) + r.getPenaltyN3(t) + r.getPenaltyN4(t);
          r.applyMask(i, t), u < a && (a = u, o = i)
        }
        return o
      }
    };
    return r;
  })();

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

  var K = { BYTE: { bit: 4 } };

  // ── Version selection and format ───────────────────────────────────────────
  var O = {};
  O.getCapacity = function(t) {
    var o = 8 * (cw[t] - M(t));
    return Math.floor((o - (t < 10 ? 12 : 20)) / 8)
  };
  O.getBestVersionForData = function(t) {
    if (!t.length) return 1;
    var len = t[0].getLength();
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

  // ── Byte-mode segment ──────────────────────────────────────────────────────
  function W(t) { this.mode = K.BYTE, this.data = new Uint8Array(t) }
  W.prototype.getLength = function() { return this.data.length };
  W.prototype.write = function(t) {
    for (var r = 0, e = this.data.length; r < e; r++) t.put(this.data[r], 8)
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

  // ── Data encoder + interleaver ────────────────────────────────────────────
  function at(t, e) {
    var n = new g;
    e.forEach(function(r) {
      n.put(r.mode.bit, 4);
      n.put(r.getLength(), t < 10 ? 8 : 16);
      r.write(n)
    });
    var o = 8 * (cw[t] - M(t));
    for (n.getLengthInBits() + 4 <= o && n.put(0, 4); n.getLengthInBits() % 8 != 0;) n.putBit(0);
    for (var s = (o - n.getLengthInBits()) / 8, u = 0; u < s; u++) n.put(u % 2 ? 17 : 236, 8);
    return function(t, r) {
      for (var n = cw[r], o = M(r), i = n - o, u = I(r), s = u - n % u, f = Math.floor(n / u), h = Math.floor(i / u), c = h + 1, g = f - h, d = new T(g), l = 0, v = new Array(u), p = new Array(u), w = 0, m = new Uint8Array(t.buffer), E = 0; E < u; E++) {
        var y = E < s ? h : c;
        v[E] = m.slice(l, l + y), p[E] = d.encode(v[E]), l += y, w = Math.max(w, y)
      }
      var A, N, B = new Uint8Array(n), C = 0;
      for (A = 0; A < w; A++)
        for (N = 0; N < u; N++) A < v[N].length && (B[C++] = v[N][A]);
      for (A = 0; A < g; A++)
        for (N = 0; N < u; N++) B[C++] = p[N][A];
      return B
    }(n, t)
  }

  // ── QR code builder ───────────────────────────────────────────────────────
  function it(t, r, n) {
    var a = t.reduce(function(t, r) { return r.data && t.push(new W(r.data)), t }, []);
    var s = O.getBestVersionForData(a);
    if (!s) throw new Error("The amount of data is too big to be stored in a QR Code");
    if (r) {
      if (r < s) throw new Error("\nThe chosen QR Code version cannot contain this amount of data.\nMinimum version required to store current data is: " + s + ".\n")
    } else r = s;
    var f = at(r, a), h = o(r), mat = new l(h);
    // Finder patterns
    !function(t, r) {
      for (var e = t.size, n = m(r), o = 0; o < n.length; o++)
        for (var a = n[o][0], i = n[o][1], u = -1; u <= 7; u++)
          if (!(a + u <= -1 || e <= a + u))
            for (var s = -1; s <= 7; s++)
              i + s <= -1 || e <= i + s || (u >= 0 && u <= 6 && (0 === s || 6 === s) || s >= 0 && s <= 6 && (0 === u || 6 === u) || u >= 2 && u <= 4 && s >= 2 && s <= 4 ? t.set(a + u, i + s, !0, !0) : t.set(a + u, i + s, !1, !0))
    }(mat, r);
    // Timing patterns
    !function(t) {
      for (var r = t.size, e = 8; e < r - 8; e++) { var n = e % 2 == 0; t.set(e, 6, n, !0), t.set(6, e, n, !0) }
    }(mat);
    // Alignment patterns
    !function(t, r) {
      for (var e = p.getPositions(r), n = 0; n < e.length; n++)
        for (var o = e[n][0], a = e[n][1], i = -2; i <= 2; i++)
          for (var u = -2; u <= 2; u++)
            -2 === i || 2 === i || -2 === u || 2 === u || 0 === i && 0 === u ? t.set(o + i, a + u, !0, !0) : t.set(o + i, a + u, !1, !0)
    }(mat, r);
    ot(mat, c.L, 0);
    // Version info (version >= 7 only)
    r >= 7 && function(t, r) {
      for (var e, n, o, a = t.size, i = O.getEncodedBits(r), u = 0; u < 18; u++) {
        e = Math.floor(u / 3), n = u % 3 + a - 8 - 3, o = 1 == (i >> u & 1);
        t.set(e, n, o, !0), t.set(n, e, o, !0)
      }
    }(mat, r);
    // Data placement
    !function(t, r) {
      for (var e = t.size, n = -1, o = e - 1, a = 7, i = 0, u = e - 1; u > 0; u -= 2) {
        for (6 === u && u--;;) {
          for (var s = 0; s < 2; s++)
            if (!t.isReserved(o, u - s)) {
              var f = !1;
              i < r.length && (f = 1 == (r[i] >>> a & 1)), t.set(o, u - s, f), -1 === --a && (i++, a = 7)
            }
          if ((o += n) < 0 || e <= o) { o -= n, n = -n; break }
        }
      }
    }(mat, f);
    isNaN(n) && (n = E.getBestMask(mat, ot.bind(null, mat, c.L)));
    E.applyMask(n, mat);
    ot(mat, c.L, n);
    return { modules: mat, version: r, errorCorrectionLevel: c.L, maskPattern: n, segments: a }
  }

  // ── Renderer ──────────────────────────────────────────────────────────────
  var st = {
    getOptions: function(t) {
      t || (t = {});
      var r = void 0 === t.margin || null === t.margin || t.margin < 0 ? 4 : t.margin,
        n = t.width && t.width >= 21 ? t.width : void 0,
        o = t.scale || 4;
      return {
        width: n, scale: n ? 4 : o, margin: r,
        color: { dark: { r: 0, g: 0, b: 0, a: 255 }, light: { r: 255, g: 255, b: 255, a: 255 } }
      }
    },
    getScale: function(t, r) {
      return r.width && r.width >= t + 2 * r.margin ? r.width / (t + 2 * r.margin) : r.scale
    },
    getImageWidth: function(t, r) {
      return Math.floor((t + 2 * r.margin) * st.getScale(t, r))
    },
    qrToImageData: function(t, e, n) {
      for (var o = e.modules.size, a = e.modules.data, i = st.getScale(o, n), u = Math.floor((o + 2 * n.margin) * i), s = n.margin * i, f = [n.color.light, n.color.dark], h = 0; h < u; h++)
        for (var c = 0; c < u; c++) {
          var g = 4 * (h * u + c), d = n.color.light;
          if (h >= s && c >= s && h < u - s && c < u - s) d = f[a[Math.floor((h - s) / i) * o + Math.floor((c - s) / i)] ? 1 : 0];
          t[g++] = d.r, t[g++] = d.g, t[g++] = d.b, t[g] = d.a
        }
    }
  };

  t.toCanvas = function(r, n, o) {
    return new Promise(function(e, a) {
      try {
        var qr = it(n, void 0, void 0);
        var opts = st.getOptions(o);
        var size = st.getImageWidth(qr.modules.size, opts);
        var ctx = r.getContext("2d");
        var img = ctx.createImageData(size, size);
        st.qrToImageData(img.data, qr, opts);
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
