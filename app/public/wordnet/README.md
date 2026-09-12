# 内置 WordNet 3.1（英英词库）

来源：npm 包 wordnet-db 3.1.14（普林斯顿大学 WordNet 3.1 数据库原文件）。
许可证：Princeton WordNet License（允许使用、复制、修改、再分发，可商用）。
本目录为 dict/ 八个必需文件的 gzip 压缩（原始合计约 34MB → 8.2MB），App 运行时
本地解压解析（src/core/wordnet.ts），零网络零外部依赖。
更新方式：npm i wordnet-db 后重跑打包脚本（见 git 历史本次提交）。
