import 'server-only';

import type { Octokit } from '@octokit/rest';
import sodium from 'libsodium-wrappers';

/**
 * Push a repository-level Actions secret to `owner/repo` via GitHub's REST API.
 *
 * GitHub requires secret values to be sealed-box-encrypted client-side using
 * the repo's libsodium public key before transmission — the API never sees
 * the plaintext, even in transit. We:
 *  1. Fetch the public key (a base64-encoded Curve25519 key plus a key_id).
 *  2. Encrypt the value as a sealed box (sodium.crypto_box_seal).
 *  3. PUT the base64-encoded ciphertext + key_id to the secrets endpoint.
 *
 * Idempotent: PUT on an existing secret name overwrites the value.
 *
 * Permissions: the caller's token needs `admin` permission on the repo
 * (GitHub's docs: "Repository administrators can create..."). On 403/404
 * this throws so callers can fall back to manual instructions.
 *
 * @throws if the public-key fetch or PUT fails — caller decides whether
 *   to surface the failure or degrade to a manual-paste flow.
 */
export async function pushRepoSecret(opts: {
  octokit: Octokit;
  owner: string;
  repo: string;
  name: string;
  value: string;
}): Promise<void> {
  const { octokit, owner, repo, name, value } = opts;

  // libsodium-wrappers initializes asynchronously; calling its primitives
  // before `ready` resolves throws a generic "sodium not ready" error.
  // ready is idempotent so calling on every push is fine.
  await sodium.ready;

  const pkResp = await octokit.actions.getRepoPublicKey({ owner, repo });
  const publicKey = sodium.from_base64(pkResp.data.key, sodium.base64_variants.ORIGINAL);
  // Convert via TextEncoder rather than sodium.from_string — the latter
  // can throw "unsupported input type for message" in some bundler/runtime
  // combinations (notably jsdom under vitest), even though both return a
  // Uint8Array. TextEncoder is a built-in and always behaves the same.
  const messageBytes = new TextEncoder().encode(value);
  const encrypted = sodium.crypto_box_seal(messageBytes, publicKey);
  const encrypted_value = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);

  await octokit.actions.createOrUpdateRepoSecret({
    owner,
    repo,
    secret_name: name,
    encrypted_value,
    key_id: pkResp.data.key_id,
  });
}
