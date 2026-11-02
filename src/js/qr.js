/*
 * Minimal QR code encoder, so the Wi-Fi card can show a code without loading anything from the
 * network or adding a dependency. Byte mode, error correction level M, versions 1–10 (up to
 * 213 bytes), which is far more than a Wi-Fi join string needs. Follows ISO/IEC 18004; the
 * structure mirrors Project Nayuki's reference encoder.
 *
 * QR.wifiText(wifi) -> 'WIFI:T:WPA;S:...;P:...;;'   the string phone cameras understand
 * QR.matrix(text)   -> rows of booleans (true = dark), or null if the text is too long
 * QR.svg(text)      -> an <svg> element with a 4-module quiet zone, or null
 */
(function () {
    'use strict';

    var MAX_VERSION = 10;
    // Level M, indexed by version.
    var ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
    var NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
    var FORMAT_ECL_M = 0;

    // ---------- Sizes

    function rawDataModules(ver) {
        var result = (16 * ver + 128) * ver + 64;
        if (ver >= 2) {
            var numAlign = Math.floor(ver / 7) + 2;
            result -= (25 * numAlign - 10) * numAlign - 55;
            if (ver >= 7) result -= 36;
        }
        return result;
    }

    function dataCodewords(ver) {
        return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
    }

    function alignmentPositions(ver, size) {
        if (ver === 1) return [];
        var numAlign = Math.floor(ver / 7) + 2;
        var step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
        var result = [6];
        for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
        return result;
    }

    // ---------- Reed–Solomon over GF(256), polynomial 0x11D

    function gfMul(x, y) {
        var z = 0;
        for (var i = 7; i >= 0; i--) {
            z = (z << 1) ^ ((z >>> 7) * 0x11D);
            z ^= ((y >>> i) & 1) * x;
        }
        return z;
    }

    function rsDivisor(degree) {
        var result = [];
        for (var i = 0; i < degree - 1; i++) result.push(0);
        result.push(1);
        var root = 1;
        for (i = 0; i < degree; i++) {
            for (var j = 0; j < result.length; j++) {
                result[j] = gfMul(result[j], root);
                if (j + 1 < result.length) result[j] ^= result[j + 1];
            }
            root = gfMul(root, 0x02);
        }
        return result;
    }

    function rsRemainder(data, divisor) {
        var result = divisor.map(function () { return 0; });
        data.forEach(function (b) {
            var factor = b ^ result.shift();
            result.push(0);
            divisor.forEach(function (coef, i) { result[i] ^= gfMul(coef, factor); });
        });
        return result;
    }

    // Splits data into blocks, adds each block's ECC, and interleaves them.
    function withEcc(data, ver) {
        var numBlocks = NUM_BLOCKS[ver];
        var eccLen = ECC_PER_BLOCK[ver];
        var raw = Math.floor(rawDataModules(ver) / 8);
        var numShort = numBlocks - raw % numBlocks;
        var shortLen = Math.floor(raw / numBlocks);
        var divisor = rsDivisor(eccLen);

        var blocks = [];
        for (var i = 0, k = 0; i < numBlocks; i++) {
            var dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
            k += dat.length;
            var ecc = rsRemainder(dat, divisor);
            if (i < numShort) dat.push(0);
            blocks.push(dat.concat(ecc));
        }

        var result = [];
        for (i = 0; i < blocks[0].length; i++) {
            for (var j = 0; j < blocks.length; j++) {
                if (i !== shortLen - eccLen || j >= numShort) result.push(blocks[j][i]);
            }
        }
        return result;
    }

    // ---------- Data

    function utf8(text) {
        var s = unescape(encodeURIComponent(text));
        var bytes = [];
        for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
        return bytes;
    }

    function encodeData(bytes) {
        for (var ver = 1; ver <= MAX_VERSION; ver++) {
            var capacity = dataCodewords(ver) * 8;
            var countBits = ver <= 9 ? 8 : 16;
            if (4 + countBits + bytes.length * 8 <= capacity) break;
        }
        if (ver > MAX_VERSION) return null;

        var bits = [];
        function put(value, len) {
            for (var i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
        }
        put(0x4, 4);
        put(bytes.length, countBits);
        bytes.forEach(function (b) { put(b, 8); });
        put(0, Math.min(4, capacity - bits.length));
        put(0, (8 - bits.length % 8) % 8);
        for (var pad = 0xEC; bits.length < capacity; pad ^= 0xEC ^ 0x11) put(pad, 8);

        var codewords = [];
        for (var i = 0; i < bits.length; i += 8) {
            var b = 0;
            for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
            codewords.push(b);
        }
        return { version: ver, codewords: codewords };
    }

    // ---------- Matrix

    function Grid(ver) {
        this.size = ver * 4 + 17;
        this.dark = [];
        this.fixed = [];
        for (var y = 0; y < this.size; y++) {
            this.dark.push([]);
            this.fixed.push([]);
            for (var x = 0; x < this.size; x++) {
                this.dark[y].push(false);
                this.fixed[y].push(false);
            }
        }
    }

    Grid.prototype.setFixed = function (x, y, isDark) {
        this.dark[y][x] = isDark;
        this.fixed[y][x] = true;
    };

    function drawFunctionPatterns(g, ver) {
        var size = g.size;
        var i, dx, dy;

        for (i = 0; i < size; i++) {
            g.setFixed(6, i, i % 2 === 0);
            g.setFixed(i, 6, i % 2 === 0);
        }

        [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) {
            for (dy = -4; dy <= 4; dy++) {
                for (dx = -4; dx <= 4; dx++) {
                    var x = c[0] + dx;
                    var y = c[1] + dy;
                    var dist = Math.max(Math.abs(dx), Math.abs(dy));
                    if (x >= 0 && x < size && y >= 0 && y < size) g.setFixed(x, y, dist !== 2 && dist !== 4);
                }
            }
        });

        var align = alignmentPositions(ver, size);
        var last = align.length - 1;
        align.forEach(function (ay, i) {
            align.forEach(function (ax, j) {
                if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
                for (dy = -2; dy <= 2; dy++) {
                    for (dx = -2; dx <= 2; dx++) {
                        g.setFixed(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
                    }
                }
            });
        });

        drawFormatBits(g, 0);

        if (ver >= 7) {
            var rem = ver;
            for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
            var bits = ver << 12 | rem;
            for (i = 0; i < 18; i++) {
                var bit = ((bits >>> i) & 1) !== 0;
                var a = size - 11 + i % 3;
                var b = Math.floor(i / 3);
                g.setFixed(a, b, bit);
                g.setFixed(b, a, bit);
            }
        }
    }

    function drawFormatBits(g, mask) {
        var size = g.size;
        var data = FORMAT_ECL_M << 3 | mask;
        var rem = data;
        for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        var bits = (data << 10 | rem) ^ 0x5412;
        function bit(n) { return ((bits >>> n) & 1) !== 0; }

        for (i = 0; i <= 5; i++) g.setFixed(8, i, bit(i));
        g.setFixed(8, 7, bit(6));
        g.setFixed(8, 8, bit(7));
        g.setFixed(7, 8, bit(8));
        for (i = 9; i < 15; i++) g.setFixed(14 - i, 8, bit(i));

        for (i = 0; i < 8; i++) g.setFixed(size - 1 - i, 8, bit(i));
        for (i = 8; i < 15; i++) g.setFixed(8, size - 15 + i, bit(i));
        g.setFixed(8, size - 8, true);
    }

    function drawCodewords(g, data) {
        var size = g.size;
        var i = 0;
        for (var right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (var vert = 0; vert < size; vert++) {
                for (var j = 0; j < 2; j++) {
                    var x = right - j;
                    var upward = ((right + 1) & 2) === 0;
                    var y = upward ? size - 1 - vert : vert;
                    if (!g.fixed[y][x] && i < data.length * 8) {
                        g.dark[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
                        i++;
                    }
                }
            }
        }
    }

    function maskHit(mask, x, y) {
        switch (mask) {
            case 0: return (x + y) % 2 === 0;
            case 1: return y % 2 === 0;
            case 2: return x % 3 === 0;
            case 3: return (x + y) % 3 === 0;
            case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            case 5: return x * y % 2 + x * y % 3 === 0;
            case 6: return (x * y % 2 + x * y % 3) % 2 === 0;
            default: return ((x + y) % 2 + x * y % 3) % 2 === 0;
        }
    }

    // XOR, so applying the same mask twice undoes it.
    function applyMask(g, mask) {
        for (var y = 0; y < g.size; y++) {
            for (var x = 0; x < g.size; x++) {
                if (!g.fixed[y][x] && maskHit(mask, x, y)) g.dark[y][x] = !g.dark[y][x];
            }
        }
    }

    // ---------- Mask choice: the standard's penalty rules, lowest score wins

    function penalty(g) {
        var size = g.size;
        var score = 0;
        var darkCount = 0;
        var x, y;

        function at(x, y, horizontal) {
            return horizontal ? g.dark[y][x] : g.dark[x][y];
        }

        [true, false].forEach(function (horizontal) {
            for (var a = 0; a < size; a++) {
                var run = 0;
                var color = null;
                for (var b = 0; b < size; b++) {
                    var c = at(b, a, horizontal);
                    if (c === color) {
                        run++;
                    } else {
                        if (run >= 5) score += 3 + run - 5;
                        color = c;
                        run = 1;
                    }
                }
                if (run >= 5) score += 3 + run - 5;

                // 1:1:3:1:1 finder-like pattern with four light modules on either side.
                for (b = -4; b < size; b++) {
                    var pattern = [true, false, true, true, true, false, true];
                    var match = pattern.every(function (p, i) {
                        var pos = b + i;
                        return pos >= 0 && pos < size && at(pos, a, horizontal) === p;
                    });
                    if (!match) continue;
                    var lightBefore = true;
                    var lightAfter = true;
                    for (var k = 1; k <= 4; k++) {
                        var before = b - k;
                        var after = b + 6 + k;
                        if (before >= 0 && at(before, a, horizontal)) lightBefore = false;
                        if (after < size && at(after, a, horizontal)) lightAfter = false;
                    }
                    if (lightBefore || lightAfter) score += 40;
                }
            }
        });

        for (y = 0; y < size; y++) {
            for (x = 0; x < size; x++) {
                if (g.dark[y][x]) darkCount++;
                if (x < size - 1 && y < size - 1) {
                    var c = g.dark[y][x];
                    if (c === g.dark[y][x + 1] && c === g.dark[y + 1][x] && c === g.dark[y + 1][x + 1]) score += 3;
                }
            }
        }

        var total = size * size;
        score += Math.floor(Math.abs(darkCount * 20 - total * 10) / total) * 10;
        return score;
    }

    // ---------- Public

    function matrix(text) {
        var encoded = encodeData(utf8(text));
        if (!encoded) return null;

        var g = new Grid(encoded.version);
        drawFunctionPatterns(g, encoded.version);
        drawCodewords(g, withEcc(encoded.codewords, encoded.version));

        var best = 0;
        var bestScore = Infinity;
        for (var mask = 0; mask < 8; mask++) {
            applyMask(g, mask);
            drawFormatBits(g, mask);
            var score = penalty(g);
            if (score < bestScore) {
                best = mask;
                bestScore = score;
            }
            applyMask(g, mask);
        }
        applyMask(g, best);
        drawFormatBits(g, best);
        return g.dark;
    }

    // One path of unit squares in module coordinates; the caller sizes it with CSS.
    function svg(text) {
        var rows = matrix(text);
        if (!rows) return null;
        var quiet = 4;
        var size = rows.length + quiet * 2;
        var d = '';
        rows.forEach(function (row, y) {
            row.forEach(function (isDark, x) {
                if (isDark) d += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z';
            });
        });
        var ns = 'http://www.w3.org/2000/svg';
        var el = document.createElementNS(ns, 'svg');
        el.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
        el.setAttribute('shape-rendering', 'crispEdges');
        var bg = document.createElementNS(ns, 'rect');
        bg.setAttribute('width', size);
        bg.setAttribute('height', size);
        bg.setAttribute('fill', '#fff');
        var path = document.createElementNS(ns, 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', '#000');
        el.appendChild(bg);
        el.appendChild(path);
        return el;
    }

    // Backslash-escapes the characters the WIFI: format treats as syntax.
    function wifiText(wifi) {
        function esc(s) { return String(s).replace(/([\\;,:"])/g, '\\$1'); }
        var security = wifi.password ? (wifi.security || 'WPA') : 'nopass';
        var text = 'WIFI:T:' + security + ';S:' + esc(wifi.ssid) + ';';
        if (wifi.password) text += 'P:' + esc(wifi.password) + ';';
        return text + ';';
    }

    window.QR = { matrix: matrix, svg: svg, wifiText: wifiText };
})();
