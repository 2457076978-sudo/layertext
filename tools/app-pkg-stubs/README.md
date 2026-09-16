# node 测试链的第三方包导入占位

`xlsx` / `docx` 是 app 的运行时依赖，但带着已知未修 advisory（xlsx@0.18.5，SheetJS 已迁自家 CDN），
装进根 devDeps 会打破根 audit=0。node 测试链目前**只穿过这两个包的 import**（lexicon/bookio 顶层），
不调用其函数——占位在**被真正使用时抛响亮错误**，绝不静默给错数据。
未来若有测试需要 xlsx/docx 真行为：给 app 升级 SheetJS CDN 版（需批准）后在根装同版，删本目录。
