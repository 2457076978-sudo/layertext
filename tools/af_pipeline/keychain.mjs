/** macOS 钥匙串读取（惰性容错）：非 macOS / 无该条目 / security 不可用返回 ''。
 *  独立小模块：管线脚本导入期查钥匙串会在 Linux/CI 启动即崩（security 命令不存在），
 *  必须在真正发起 AI 调用点才取 key。 */
import { execSync } from 'node:child_process';

export function keychainGet(service) {
  if (process.platform !== 'darwin') return '';
  try {
    return execSync(`security find-generic-password -s ${service} -w`).toString().trim();
  } catch {
    return '';
  }
}
