'use strict';
// Port of r6-dissect (https://github.com/redraskal/r6-dissect, MIT License,
// Copyright (c) 2022 Benjamin Ryan) to plain Node.js. See ./LICENSE.
// Source: dissect/reader.go (readChunkedData / readNonChunkedData).
//
// Upstream decompresses every zstd frame found after the header with a streaming
// decoder and counts the consumed bytes. Node's zlib.zstdDecompressSync cannot report
// consumed bytes, so we walk the zstd frame structure ourselves to find frame ends and
// then decompress contiguous runs of frames in one call.

const zlib = require('zlib');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Returns the end offset (exclusive) of the zstd frame that starts at `pos`,
 * or -1 when the frame is malformed / truncated.
 */
function frameEnd(buf, pos) {
  const n = buf.length;
  let p = pos + 4;
  if (p >= n) return -1;
  const fhd = buf[p++];
  const fcsFlag = fhd >> 6;
  const single = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  if (!single) p += 1; // window descriptor
  p += [0, 1, 2, 4][dictFlag];
  p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  for (;;) {
    if (p + 3 > n) return -1;
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = h & 1;
    const type = (h >> 1) & 3;
    const size = h >>> 3;
    if (type === 3) return -1;
    p += type === 1 ? 1 : size;
    if (p > n) return -1;
    if (last) break;
  }
  if (checksum) p += 4;
  return p > n ? -1 : p;
}

/**
 * Finds all complete zstd frames starting at `from` and returns the decompressed
 * concatenation. `warnings` receives a note for truncated or undecodable frames.
 */
function decompressFrames(buf, from, warnings) {
  const parts = [];
  let pos = from;
  let runStart = -1;
  let runEnd = -1;
  const flush = () => {
    if (runStart < 0) return;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(runStart, runEnd), { chunkSize: 1 << 22 }));
    } catch (e) {
      // Fall back to frame-by-frame so one bad frame does not lose the rest.
      let p = runStart;
      while (p < runEnd) {
        const e2 = frameEnd(buf, p);
        if (e2 < 0) break;
        try {
          parts.push(zlib.zstdDecompressSync(buf.subarray(p, e2)));
        } catch (err) {
          warnings.push(`zstd frame at ${p} failed: ${err.message}`);
        }
        p = e2;
      }
    }
    runStart = -1;
  };
  while (pos < buf.length) {
    const m = buf.indexOf(ZSTD_MAGIC, pos);
    if (m < 0) break;
    const end = frameEnd(buf, m);
    if (end < 0) {
      flush();
      warnings.push(`truncated or invalid zstd frame at ${m}`);
      pos = m + 4;
      continue;
    }
    if (runStart >= 0 && m === runEnd) {
      runEnd = end;
    } else {
      flush();
      runStart = m;
      runEnd = end;
    }
    pos = end;
  }
  flush();
  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}

/** Decompresses a whole file that starts directly with a zstd frame (pre Y8S4 format). */
function decompressWhole(buf, warnings) {
  return decompressFrames(buf, 0, warnings);
}

module.exports = { ZSTD_MAGIC, frameEnd, decompressFrames, decompressWhole };
