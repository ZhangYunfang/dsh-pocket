// Small shared helpers for the optional LAN IP override.

/** @param {unknown} value
 *  @returns {boolean}
 *
 * 严格 IPv4 字面量（不解析端口/前缀）：用于「把用户填的地址写进二维码/状态页」。
 * 只做数字合法性检查的旧实现会把 `0.0.0.0`、广播/组播地址和带前导零的
 * `010.0.0.1`（部分系统按八进制解释）都当成可展示的局域网地址。
 */
export function isValidIpv4(value) {
  const m = String(value ?? '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m === null) return false;
  // 前导零一律拒绝：inet_aton 家族按八进制解释，展示值与实际连接目标会不一致。
  if (m.slice(1).some((part) => part.length > 1 && part.startsWith('0'))) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 0 || a >= 224) return false;        // 本网络/保留/组播/广播段
  if (a === 255 && b === 255 && c === 255 && d === 255) return false;
  return true;
}
