# LayerText MCP 服务

把 LayerText 的质检引擎接进任何 MCP 客户端（Claude Desktop、ZCode、Cursor 等），
让 AI 助手在你聊天的窗口里直接调"生词率/句法黑名单/改写复核"——不用打开应用。

## 提供 4 个工具（全部本地计算、零遥测、不落盘）

| 工具 | 用途 | 典型场景 |
|---|---|---|
| `layer_qc` | 全文体检：覆盖率/生词率/句长/被动/定从/过去完成/OOV 清单 | 简化前评估原文难度、简化后验收 |
| `layer_word_status` | 单词词表状态与词形还原原形 | "这个词学生学过吗？" |
| `layer_sentence_risks` | 逐句句法黑名单检测（被/从/完/超长） | 找出需要改写的句子 |
| `layer_check_revision` | 改写句复核（按句拆分，超长=最长一句超限） | **AI 改完英文自查残留再交付** |
| `layer_align` | 两版逐句核对：丢句/新增/数字专名缺失（three↔3 互认） | **AI 交付简化稿前核对零丢句** |

口径与桌面应用完全一致（同一套 `src/core` 引擎）：词库=难度锚点（内置课标 1600+补录，可用参数叠加教材已学词 CSV）；被动/定从/过去完成按初中教学进度一律禁用；直接引语内豁免；词形还原。

## 启动与配置

```bash
cd LayerText
npm install && npm run build
node dist/src/mcp-server.js                 # 最简启动（内置词表）
node dist/src/mcp-server.js --vocab 教材词库.csv --terms 术语表.txt   # 叠加自定义词库
```

Claude Desktop 配置（`~/Library/Application Support/Claude/claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "layertext-qc": {
      "command": "node",
      "args": ["/绝对路径/LayerText/dist/src/mcp-server.js",
               "--vocab", "/绝对路径/你的教材词库.csv"]
    }
  }
}
```

其他 MCP 客户端（ZCode/Cursor 等）同理：command=`node`，args 指向 `dist/src/mcp-server.js`（可带 `--vocab/--wordlist/--terms/--proper`，均可多次）。

## 隐私与红线

- stdio 传输、纯本地进程：**没有任何网络请求、不上传任何数据**（零遥测红线延伸到 MCP）；
- 工具只处理调用方传入的文本、只返回结果，不写任何文件；
- 提醒：把文本发给 MCP 客户端 ≠ 发给本工具——若你的客户端是云端模型，文本会经过云端，
  请勿用它处理含真实学生信息的内容（教学用自写/公版文本无碍）。

## 已知发现记录

2026-09-06 首次冒烟测试即抓到引擎漏检：`was sung` 不计数（sung 不在 PASSIVE_IRR 不规则分词表），
与 W1 评测集抓到的 `was built` 同类。已批量补入 22 个常用被动分词（TS 与 Python 参照版同步），
金标准评测与双引擎对照全绿——这也是 MCP 化的第一个工程回报：更大范围的调用面=更多真实语料在帮你测引擎。
