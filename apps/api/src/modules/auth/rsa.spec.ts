import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { rsaEncrypt } from './rsa';

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n;
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

function b64urlToHex(s: string): string {
  return Buffer.from(s, 'base64url').toString('hex');
}

describe('rsaEncrypt', () => {
  it('与标准 RSA 私钥可往返解密（16 位进制 + 小端字节打包自洽）', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const pub = publicKey.export({ format: 'jwk' });
    const priv = privateKey.export({ format: 'jwk' });
    const n = BigInt(`0x${b64urlToHex(pub.n!)}`);
    const e = BigInt(`0x${b64urlToHex(pub.e!)}`);
    const d = BigInt(`0x${b64urlToHex(priv.d!)}`);

    const plaintext = 'hello123';
    const reversed = plaintext.split('').reverse().join('');
    const cipherHex = rsaEncrypt(reversed, n.toString(16), e.toString(16));

    const chunkSize = 2 * (Math.ceil(n.toString(2).length / 16) - 1);
    const chars: number[] = [];
    for (const c of cipherHex.split(' ')) {
      let m = modPow(BigInt(`0x${c}`), d, n);
      for (let j = 0; j < chunkSize; j++) {
        chars.push(Number(m & 0xffn));
        m >>= 8n;
      }
    }
    const recovered = String.fromCharCode(...chars).replace(/\0+$/, '');
    expect(recovered).toBe(reversed);
  });

  it('输出为空格分隔的小写十六进制（每段长度为 4 的倍数）', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const pub = publicKey.export({ format: 'jwk' });
    const n = BigInt(`0x${b64urlToHex(pub.n!)}`);
    const e = BigInt(`0x${b64urlToHex(pub.e!)}`);
    const out = rsaEncrypt('abc', n.toString(16), e.toString(16));
    expect(out.length).toBeGreaterThan(0);
    for (const seg of out.split(' ')) {
      expect(seg).toMatch(/^[0-9a-f]+$/);
      expect(seg.length % 4).toBe(0);
    }
  });
});
