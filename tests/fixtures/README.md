# 验收音频

`nota-speech.wav`、`nota-chinese.wav` 是 Windows SAPI 生成的合成语音，不是真实人物或会议录音。

中文样本是“我刚和王经理聊完……”的个人口述备忘，包含提及的人物、星河项目、报价 12.8 万元，以及明确的待办、日程、提前一天提醒。原始文稿见 `nota-chinese.txt`。原始语音中的日期为 2026-11-20；真实 API 验收会在用户交办中明确将执行日期平移到运行日之后第 8 天，避免固定样本过期影响提醒测试。

`browser-capture.webm` 来自 Chromium MediaRecorder 录制该合成音频的前约 3.2 秒；容器没有 duration 字段，用于验证浏览器录音兼容性。

`pnpm test:live` 调用真实 GMI 与 OpenAI，产生少量 API 用量。测试报告与临时账号存入被 Git 忽略的 `test-results/`；常规单元和集成测试不调用付费模型。个人便签验收还覆盖用户任务与转述的第三方承诺区分；不再调用声纹或分说话人接口。
