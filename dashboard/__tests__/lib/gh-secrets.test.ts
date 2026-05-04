// @vitest-environment node
//
// libsodium does an `instanceof Uint8Array` check on inputs and rejects
// jsdom's Uint8Array (cross-realm — different constructor than Node's).
// The actual server-action code runs under Node in production, so we use
// the Node test environment for this file specifically.
import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import sodium from 'libsodium-wrappers';

import { pushRepoSecret } from '@/lib/gh-secrets';

/**
 * Generate a fresh libsodium key pair so the test can assert the
 * encrypted payload actually round-trips back to the plaintext when
 * decrypted with the matching private key. This is what catches the
 * "I called the encryption function with the wrong arguments" bug
 * class — and it does so without depending on any GH-API behavior.
 */
async function makeKeyPair() {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  return {
    publicKey: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL),
    secretKey: kp.privateKey,
    keyPublicBytes: kp.publicKey,
  };
}

describe('pushRepoSecret', () => {
  it('encrypts the value with the repo public key and PUTs to the secrets endpoint', async () => {
    const { publicKey, secretKey, keyPublicBytes } = await makeKeyPair();

    type CreateOrUpdateSecretArg = {
      owner: string;
      repo: string;
      secret_name: string;
      key_id: string;
      encrypted_value: string;
    };
    const getRepoPublicKey = vi.fn(async (_args: { owner: string; repo: string }) => ({
      data: { key_id: 'KEY_001', key: publicKey },
    }));
    const createOrUpdateRepoSecret = vi.fn(async (_args: CreateOrUpdateSecretArg) => ({}));

    const octokit = {
      actions: { getRepoPublicKey, createOrUpdateRepoSecret },
    } as unknown as Octokit;

    const plaintext = 'sk-ant-test-value-not-real';
    await pushRepoSecret({
      octokit,
      owner: 'q',
      repo: 'r',
      name: 'ANTHROPIC_API_KEY',
      value: plaintext,
    });

    expect(getRepoPublicKey).toHaveBeenCalledWith({ owner: 'q', repo: 'r' });
    expect(createOrUpdateRepoSecret).toHaveBeenCalledTimes(1);
    const arg = createOrUpdateRepoSecret.mock.calls[0]?.[0];
    if (!arg) throw new Error('createOrUpdateRepoSecret was not called');
    expect(arg.owner).toBe('q');
    expect(arg.repo).toBe('r');
    expect(arg.secret_name).toBe('ANTHROPIC_API_KEY');
    expect(arg.key_id).toBe('KEY_001');

    // Round-trip the ciphertext to confirm we encrypted with the right
    // public key and the value isn't corrupted in transit.
    const ciphertext = sodium.from_base64(arg.encrypted_value, sodium.base64_variants.ORIGINAL);
    const decrypted = sodium.crypto_box_seal_open(ciphertext, keyPublicBytes, secretKey);
    expect(new TextDecoder().decode(decrypted)).toBe(plaintext);
  });

  it('propagates errors from the public-key fetch (e.g. 403 admin-required)', async () => {
    const octokit = {
      actions: {
        getRepoPublicKey: vi.fn(async () => {
          const err = Object.assign(new Error('Resource not accessible by integration'), {
            status: 403,
          });
          throw err;
        }),
        createOrUpdateRepoSecret: vi.fn(),
      },
    } as unknown as Octokit;

    await expect(
      pushRepoSecret({ octokit, owner: 'q', repo: 'r', name: 'X', value: 'y' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
