// The HTTPS certificate of the phone preview. A phone trusts a small certificate authority once, and
// that authority signs a certificate for this machine's current addresses whenever the preview server
// starts. Name constraints limit the authority to private IPv4 addresses, so a phone that trusts it
// trusts nothing else; its key is stored encrypted by the OS, like the device key.
import { randomBytes, webcrypto } from 'node:crypto'
import * as x509 from '@peculiar/x509'
import { openSecret, sealSecret } from '../../main/platform'
import { loadJson, saveJson } from '../../main/store'

x509.cryptoProvider.set(webcrypto as never)

const FILE = 'tools/mobile-ui/ca.json'
const EC = { name: 'ECDSA', namedCurve: 'P-256' }
const SIGN = { name: 'ECDSA', hash: 'SHA-256' }
const DAY = 24 * 3600_000
/** Phones refuse server certificates valid for longer than 825 days; stay well under. */
const SERVER_DAYS = 397
const CA_YEARS = 20

/** Private and link-local IPv4 ranges, plus loopback, as [address, mask]. */
const PRIVATE: [number[], number[]][] = [
  [[10, 0, 0, 0], [255, 0, 0, 0]],
  [[172, 16, 0, 0], [255, 240, 0, 0]],
  [[192, 168, 0, 0], [255, 255, 0, 0]],
  [[169, 254, 0, 0], [255, 255, 0, 0]],
  [[127, 0, 0, 0], [255, 0, 0, 0]]
]

/** DER: a tag, its length and its contents. */
function tlv(tag: number, body: Uint8Array): Uint8Array {
  const n = body.length
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]
  return Uint8Array.from([tag, ...len, ...body])
}
const seq = (...items: Uint8Array[]) => tlv(0x30, Uint8Array.from(items.flatMap((i) => [...i])))

/**
 * NameConstraints with only permitted subtrees: the private IPv4 ranges, and one DNS name that does not
 * exist, so no DNS name passes either.
 */
function nameConstraints(): Uint8Array {
  const subtrees = [
    seq(tlv(0x82, new TextEncoder().encode('symphony.invalid'))),
    ...PRIVATE.map(([ip, mask]) => seq(tlv(0x87, Uint8Array.from([...ip, ...mask]))))
  ]
  return seq(tlv(0xa0, Uint8Array.from(subtrees.flatMap((s) => [...s]))))
}

const serial = () => `01${randomBytes(15).toString('hex')}`

interface Authority {
  cert: x509.X509Certificate
  key: CryptoKey
}

let authority: Promise<Authority> | null = null

function loadAuthority(): Promise<Authority> {
  authority ??= (async () => {
    const saved = loadJson<{ cert: string; key: string } | null>(FILE, null)
    if (saved) {
      const der = x509.PemConverter.decodeFirst(openSecret(saved.key))
      return { cert: new x509.X509Certificate(saved.cert), key: await webcrypto.subtle.importKey('pkcs8', der, EC, false, ['sign']) }
    }
    const keys = await webcrypto.subtle.generateKey(EC, true, ['sign', 'verify'])
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: serial(),
      name: 'CN=Symphony phone preview',
      notBefore: new Date(Date.now() - DAY),
      notAfter: new Date(Date.now() + CA_YEARS * 365 * DAY),
      signingAlgorithm: SIGN,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        new x509.Extension('2.5.29.30', true, nameConstraints()),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey)
      ]
    })
    const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
    saveJson(FILE, () => ({ cert: cert.toString('pem'), key: sealSecret(x509.PemConverter.encode(pkcs8, 'PRIVATE KEY')) }), 0)
    return { cert, key: keys.privateKey }
  })().catch((err) => {
    authority = null
    throw err
  })
  return authority
}

/** The authority's certificate (DER), for a phone to install and trust. */
export async function authorityCert(): Promise<Buffer> {
  return Buffer.from((await loadAuthority()).cert.rawData)
}

/** A key and certificate chain for this machine's addresses, signed by the authority. */
export async function serverCert(addresses: string[]): Promise<{ key: string; cert: string }> {
  const ca = await loadAuthority()
  const keys = await webcrypto.subtle.generateKey(EC, true, ['sign', 'verify'])
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: 'CN=Symphony preview',
    issuer: ca.cert.subject,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + SERVER_DAYS * DAY),
    signingAlgorithm: SIGN,
    publicKey: keys.publicKey,
    signingKey: ca.key,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension(addresses.map((ip) => ({ type: 'ip' as const, value: ip }))),
      await x509.AuthorityKeyIdentifierExtension.create(ca.cert.publicKey),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey)
    ]
  })
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  return { key: x509.PemConverter.encode(pkcs8, 'PRIVATE KEY'), cert: `${cert.toString('pem')}\n${ca.cert.toString('pem')}` }
}
