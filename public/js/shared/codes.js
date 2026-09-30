// World codes: short, unambiguous, easy to read aloud. Shared by the server,
// which hands them out, and by peer-to-peer hosts, which use them as peer ids.

// No 0/O or 1/I/L, so a code read off a screen survives being typed.
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 5;

// The PeerJS signaling server is shared with every other app, so namespace our ids.
export const PEER_PREFIX = 'ctb-world-';

const randomBytes = (count) => globalThis.crypto.getRandomValues(new Uint8Array(count));

export function generateCode(random = randomBytes) {
  // Drop bytes past the last whole multiple of the alphabet so every symbol is equally likely.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const byte of random(CODE_LENGTH)) {
      if (byte < limit && code.length < CODE_LENGTH) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return code;
}

export function normalizeCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
}

export function isValidCode(code) {
  return typeof code === 'string' && code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

export const peerIdFor = (code) => PEER_PREFIX + code;
