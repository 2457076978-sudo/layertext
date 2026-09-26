/**
 * AI 故障人话翻译（复盘方案 B2，2026-09-26）· 唯一实现
 *
 * 交互自解释性标准 v0.1 的 B3 条款（拦截不是终点是转向）在 AI 通路上的统一出口：
 * 网络断 / key 被拒 / 限流 / 超时 / 思考型截断，各给一句"为什么 + 去哪改"。
 * 此前三条 AI 通路（审核建议 / 改写本句 / 批量换词）各自只认"未找到 JSON"一种形态，
 * 网络故障一律裸奔成 `TypeError: fetch failed`。纯函数零依赖，AI catch 站点统一消费；
 * 新错误家族加一行表即全站生效。
 */

/** 返回带前导空格的提示句；无法识别的错误返回空串（调用方原样展示错误本身）。 */
export function aiFailureHint(e: unknown): string {
  const s = String(e);
  if (s.includes('未找到 JSON')) {
    return '（原因：模型把"思考过程"写进了回答，占满输出上限还没写到 JSON——AI 设置里换非思考型模型如 deepseek-chat 最省心，或减少一次标记的数量分批出）';
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|network/i.test(s)) {
    return '（网络连不上供应商——先看本机网络/代理是否正常，再核对 AI 设置里的 baseUrl 拼写）';
  }
  if (/HTTP 40[13]/.test(s)) {
    return '（key 被供应商拒绝——去供应商控制台重新生成 key，回菜单 LayerText → AI 设置更新）';
  }
  if (/HTTP 429/.test(s)) {
    return '（限流——稍等一分钟再试，或在 AI 设置里配备用供应商，失败会自动切换）';
  }
  if (/HTTP 5\d\d/.test(s)) {
    return '（供应商服务端出错——稍等重试；连着失败就换备用供应商）';
  }
  if (/timeout|aborted?|AbortError/i.test(s)) {
    return '（等待超时——网络慢或模型太忙，重试一次；经常超时就换个轻量模型）';
  }
  return '';
}
