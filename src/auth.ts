// The board's sign-in: its public key must hash to the board id it dialled, and its signature
// must cover this connection's challenge and the host it dialled.

import { boardIdOf } from './boardId';
import { authSignedBytes, type Auth } from './wire';

export async function verifyBoardAuth(a: Auth, challenge: Uint8Array, host: string, id: string): Promise<boolean> {
  if ((await boardIdOf(a.publicKey)) !== id) return false;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('raw', a.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    return false; // not a point on the curve
  }
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    a.signature,
    authSignedBytes(challenge, host, a.firmware),
  );
}
