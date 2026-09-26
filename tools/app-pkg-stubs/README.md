# node 测试链的第三方包导入占位

`docx` 是 app 的运行时依赖。~~xlsx~~ 已于 2026-09-26（A5）移除：app 词表导入改用
自建读取器 `app/src/xlsxread.ts`（fflate 解压 + 窄口径 XML 解析，输出经
tests/xlsxread.test.ts 字节锁对齐旧 xlsx@0.18.5）。
docx 占位在**被真正使用时抛响亮错误**，绝不静默给错数据。
未来若测试需要 docx 真行为：升级后在根装同版，删对应桩。
