/** macOS 钥匙串读取（惰性容错）：非 macOS / 无该条目 / security 不可用返回 ''。
 *  独立小模块：管线脚本导入期查钥匙串会在 Linux/CI 启动即崩（security 命令不存在），
 *  必须在真正发起 AI 调用点才取 key。
 *
 *  2026-09-13：`execSync` 模板串改 `execFileSync` + 数组传参。
 *  当时的 `service` 全部是硬编码字面量（`layertext.apikey` / `layertext.ecnukey`），
 *  所以**从没被利用过**；但这个签名收的是任意字符串，任何将来把用户名、
 *  项目配置或命令行传进来的调用方，都会让 `foo; rm -rf ~` 直接进 shell。
 *  数组传参让这类参数**在结构上**不可能被解释成命令，不是靠调用方自觉。 */
import { execFileSync } from 'node:child_process';

export function keychainGet(service) {
  if (process.platform !== 'darwin') return '';
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}
