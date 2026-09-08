/**
 * Pure-JS secp256k1 backend for bip32 (BIP32Factory), via @noble/secp256k1.
 *
 * Why this file exists: bip32's default companion, tiny-secp256k1, loads a
 * 1.2 MB secp256k1.wasm via `new URL(wasm, import.meta.url)`. Any bundler
 * (Netlify's esbuild default; nft can also drop the untraced .wasm) breaks
 * that reference and EVERY payment address request fails ("Invalid URL").
 * This adapter is dependency-free pure JS (no WASM, no native addon, no fs),
 * so it survives any bundler. Interface matches tiny-secp256k1 exactly
 * (verified against bip32's own testEcc vectors + cross-implementation
 * address equality — see repo history / deployment notes).
 */
import { ProjectivePoint, CURVE, etc, sign as nobleSign, verify as nobleVerify } from "@noble/secp256k1";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

// noble v2 ships hash-agnostic: wire Node-compatible sync hashes once.
// (Without this, sign() throws "hashes.hmacSha256Sync not set".)
if (!etc.hmacSha256Sync) {
  etc.hmacSha256Sync = (key, ...msgs) => hmac(sha256, key, etc.concatBytes(...msgs));
}
if (!etc.sha256Sync) {
  etc.sha256Sync = (...msgs) => sha256(etc.concatBytes(...msgs));
}

const N = CURVE.n;

function bytesToNumber(bytes) {
  if (!bytes || bytes.length === 0) return 0n;
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return BigInt("0x" + hex);
}

function numberToBytes32(num) {
  let hex = num.toString(16);
  if (hex.length > 64) throw new Error("number out of range");
  hex = hex.padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const ecc = {
  isPoint(p) {
    try {
      if (!(p instanceof Uint8Array) || (p.length !== 33 && p.length !== 65)) return false;
      ProjectivePoint.fromHex(p);
      return true;
    } catch {
      return false;
    }
  },

  isPrivate(d) {
    try {
      if (!(d instanceof Uint8Array) || d.length !== 32) return false;
      const n = bytesToNumber(d);
      return n > 0n && n < N;
    } catch {
      return false;
    }
  },

  pointFromScalar(d, compressed = true) {
    try {
      if (!ecc.isPrivate(d)) return null;
      return ProjectivePoint.fromPrivateKey(d).toRawBytes(compressed);
    } catch {
      return null;
    }
  },

  pointAddScalar(p, tweak, compressed = true) {
    try {
      const P = ProjectivePoint.fromHex(p);
      const t = bytesToNumber(tweak);
      if (t <= 0n || t >= N) return null;
      const Q = P.add(ProjectivePoint.BASE.multiply(t));
      return Q.toRawBytes(compressed);
    } catch {
      return null;
    }
  },

  privateAdd(d, tweak) {
    try {
      if (!(d instanceof Uint8Array) || d.length !== 32) return null;
      const a = bytesToNumber(d);
      const t = bytesToNumber(tweak);
      if (a <= 0n || a >= N || t < 0n || t >= N) return null;
      const r = (a + t) % N;
      if (r === 0n) return null;
      return numberToBytes32(r);
    } catch {
      return null;
    }
  },

  privateNegate(d) {
    const a = bytesToNumber(d);
    return numberToBytes32(N - (a % N));
  },

  sign(h, d) {
    return nobleSign(h, d).toCompactRawBytes();
  },

  verify(h, Q, signature) {
    try {
      return nobleVerify(signature, h, Q);
    } catch {
      return false;
    }
  },
};
