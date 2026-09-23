/**
 * 复刻 BBICloud 前端 RSAUtils 的原始 RSA 加密（无 PKCS#1 填充）。
 *
 * 已按上游真实实现（chunk-0b08b4aa.c3b79fcf.js）核对：
 *   - 大整数采用 jsbn 16 位进制：biRadix = 2^16，biRadixBits = 16
 *   - chunkSize = 2 * biHighIndex(modulus)，单位为「字符数」
 *   - 每个 digit 打包两个字符：digits[n] = s[2n] + (s[2n+1] << 8)
 *     （等价于将明文按小端字节序解释为大整数；密码为 ASCII 时严格成立）
 *   - 密文用 biToHex 输出：每 16 位 digit 固定 4 个十六进制字符
 */

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

/** biToHex：每 16 位 digit 固定 4 个十六进制字符（高位不足补 0）。 */
function biToHex(n: bigint): string {
  let hex = n.toString(16);
  const rem = hex.length % 4;
  if (rem !== 0) hex = hex.padStart(hex.length + (4 - rem), '0');
  return hex;
}

/**
 * 对明文做原始 RSA 加密，返回空格分隔的十六进制密文。
 * 与 RSAUtils.encryptedString(key, reversedPassword) 等价。
 */
export function rsaEncrypt(plaintext: string, modulusHex: string, exponentHex: string): string {
  const N = BigInt(`0x${modulusHex}`);
  const E = BigInt(`0x${exponentHex}`);
  const bitLength = N.toString(2).length;
  // biRadixBits = 16 → chunkSize = 2 * biHighIndex(modulus)（单位：字符）
  const chunkSize = 2 * (Math.ceil(bitLength / 16) - 1);
  if (chunkSize <= 0) throw new Error('非法的 RSA 模数');

  const chars: number[] = [];
  for (let i = 0; i < plaintext.length; i++) chars.push(plaintext.charCodeAt(i));
  while (chars.length % chunkSize !== 0) chars.push(0);

  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += chunkSize) {
    // 小端字节序：chars[i] 为最低字节
    let block = 0n;
    for (let j = chunkSize - 1; j >= 0; j--) {
      block = (block << 8n) | BigInt(chars[i + j] & 0xff);
    }
    chunks.push(biToHex(modPow(block, E, N)));
  }
  return chunks.join(' ');
}
