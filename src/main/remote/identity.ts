// This machine's identity for remote orchestration: a key pair and a self-signed certificate made
// on first use. The certificate's SHA-256 fingerprint is the machine id. The private key is stored
// encrypted by the OS (platform.ts: Keychain on macOS, DPAPI on Windows).
import { createHash, X509Certificate } from 'node:crypto'
import type { TLSSocket } from 'node:tls'
import selfsigned from 'selfsigned'
import { openSecret, sealSecret } from '../platform'
import { flushAll, loadJson, saveJson } from '../store'

export interface Identity {
  cert: string
  key: string
  /** Lowercase hex SHA-256 of the certificate: the machine id. */
  id: string
}

const FILE = 'identity.json'
let cached: Promise<Identity> | null = null

export function deviceIdentity(): Promise<Identity> {
  cached ??= load().catch((err) => {
    cached = null
    throw err
  })
  return cached
}

/** The identity if one was made before, without making one. */
export function existingIdentityId(): string | null {
  const saved = loadJson<{ cert?: string } | null>(FILE, null)
  return saved?.cert ? fingerprint(saved.cert) : null
}

async function load(): Promise<Identity> {
  const saved = loadJson<{ cert: string; key: string } | null>(FILE, null)
  if (saved) return { cert: saved.cert, key: openSecret(saved.key), id: fingerprint(saved.cert) }
  const made = await selfsigned.generate([{ name: 'commonName', value: 'Symphony' }], {
    keyType: 'ec',
    curve: 'P-256',
    notAfterDate: new Date(Date.now() + 30 * 365 * 24 * 3600_000),
    extensions: [{ name: 'extKeyUsage', serverAuth: true, clientAuth: true }]
  })
  const sealed = sealSecret(made.private)
  saveJson(FILE, () => ({ cert: made.cert, key: sealed }), 0)
  await flushAll()
  return { cert: made.cert, key: made.private, id: fingerprint(made.cert) }
}

export function fingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase()
}

/** The fingerprint of the certificate the other side presented on this TLS connection. */
export function peerFingerprint(socket: TLSSocket): string | null {
  const fp = socket.getPeerCertificate()?.fingerprint256
  return fp ? fp.replace(/:/g, '').toLowerCase() : null
}

/**
 * The 6-digit code both screens show while pairing. It depends on both certificates, so a
 * man-in-the-middle (who must present different certificates) produces different codes.
 */
export function pairingCode(a: string, b: string): string {
  const [x, y] = [a, b].sort()
  const h = createHash('sha256').update(`symphony-pair\n${x}\n${y}`).digest()
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}
