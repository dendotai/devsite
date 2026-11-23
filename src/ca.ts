// One CA root for every Mac (#104): the working copy is Caddy's own local CA in its storage, a copy is in the user's secret store, and the root moves between them only through a pipe — `devsite ca export` prints it, `devsite init --ca -` reads it.
import { createPrivateKey, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { rootCrtIn, rootKeyIn } from "./storage";

export type CaRoot = { certPem: string; keyPem: string; cert: X509Certificate };

const PEM_BLOCK = /-----BEGIN ([A-Z ]+)-----[\s\S]+?-----END \1-----/g;

export function parseCaRoot(text: string): CaRoot | string {
  const blocks = [...text.matchAll(PEM_BLOCK)];
  const certs = blocks.filter((b) => b[1] === "CERTIFICATE");
  const keys = blocks.filter((b) => b[1]?.endsWith("PRIVATE KEY"));
  if (certs.length !== 1 || keys.length !== 1) {
    return "standard input needs one CERTIFICATE and one PRIVATE KEY block, as `devsite ca export` prints them";
  }
  const certPem = `${certs[0]?.[0]}\n`;
  const keyPem = `${keys[0]?.[0]}\n`;
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch (err) {
    return `the certificate on standard input does not parse: ${(err as Error).message}`;
  }
  if (!cert.ca) return "the certificate on standard input is not a CA certificate";
  try {
    if (!cert.checkPrivateKey(createPrivateKey(keyPem))) {
      return "the private key on standard input is not the certificate's key";
    }
  } catch (err) {
    return `the private key on standard input does not parse: ${(err as Error).message}`;
  }
  return { certPem, keyPem, cert };
}

// null when the storage holds no root yet; a root with no key cannot be exported, so export reads both.
export function readCaRoot(storageRoot: string): { certPem: string; keyPem: string } | null {
  const crt = rootCrtIn(storageRoot);
  const key = rootKeyIn(storageRoot);
  if (!existsSync(crt) || !existsSync(key)) return null;
  return { certPem: readFileSync(crt, "utf8"), keyPem: readFileSync(key, "utf8") };
}

export function currentRootCert(storageRoot: string): X509Certificate | null {
  try {
    return new X509Certificate(readFileSync(rootCrtIn(storageRoot)));
  } catch {
    return null;
  }
}

// "Test Root (SHA-256 1A:2B:3C:4D…)": the name a user sees in Keychain Access, and enough of the fingerprint to tell two roots of one name apart.
export function describeRoot(cert: X509Certificate): string {
  const cn = cert.subject.match(/(?:^|\n)CN=([^\n]+)/)?.[1] ?? cert.subject;
  return `${cn} (SHA-256 ${cert.fingerprint256.slice(0, 11)}…)`;
}

// Caddy keeps an intermediate it finds without checking it against the root (caddypki ca.go), and serves a certificate it holds in storage while it is valid, so both go: Caddy makes a new intermediate at its next start and signs each name again at its next visit.
export function importCaRoot(storageRoot: string, root: CaRoot) {
  const crt = rootCrtIn(storageRoot);
  const dir = dirname(crt);
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, "intermediate.crt"), { force: true });
  rmSync(join(dir, "intermediate.key"), { force: true });
  rmSync(join(storageRoot, "certificates", "local"), { recursive: true, force: true });
  // The certificate lands last, each file whole by rename: a run that stops before it leaves the old root.crt, so the next `init --ca -` sees a different root and imports again.
  const place = (path: string, text: string, mode: number) => {
    writeFileSync(`${path}.devsite-import`, text, { mode });
    renameSync(`${path}.devsite-import`, path);
  };
  place(rootKeyIn(storageRoot), root.keyPem, 0o600);
  place(crt, root.certPem, 0o644);
}
