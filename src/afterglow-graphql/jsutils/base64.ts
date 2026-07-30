const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

/**
 * Base64-encode a string, UTF-8 encoding it first.
 *
 * `btoa` alone throws on code units above 0xFF, and code units in the
 * 0x80–0xFF range would be ambiguous with UTF-8 bytes on decode — so any
 * string containing a non-ASCII character takes the byte-wise UTF-8 route.
 * ASCII strings (the common case for global IDs) hit `btoa` directly.
 */
export function base64EncodeUtf8(value: string): string {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) {
      const bytes = utf8Encoder.encode(value);
      let binary = '';
      for (let j = 0; j < bytes.length; j++) {
        binary += String.fromCharCode(bytes[j]!);
      }
      return btoa(binary);
    }
  }
  return btoa(value);
}

/**
 * Decode a base64 string produced by `base64EncodeUtf8`.
 *
 * Throws (from `atob`) on malformed base64 — callers translate. Invalid
 * UTF-8 byte sequences decode with U+FFFD replacement rather than throwing.
 */
export function base64DecodeUtf8(value: string): string {
  const binary = atob(value);
  for (let i = 0; i < binary.length; i++) {
    if (binary.charCodeAt(i) > 0x7f) {
      const bytes = new Uint8Array(binary.length);
      for (let j = 0; j < binary.length; j++) {
        bytes[j] = binary.charCodeAt(j);
      }
      return utf8Decoder.decode(bytes);
    }
  }
  return binary;
}
