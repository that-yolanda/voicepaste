# VoicePaste Performance Test Report / VoicePaste 性能测试报告

## Notes / 测试说明

- This report is based on local measurements, not a lab benchmark.
- Metrics were collected from macOS Activity Monitor. The README uses the `Memory` column for the VoicePaste process group as the main reference.
- `Real Memory`, `Private Memory`, `Shared Memory`, and `VM Compressed` are included for diagnostics and should not be treated as a single summed product claim.
- Results may vary depending on system load, macOS memory compression, whether the app was restarted, model switching order, CPU/CoreML backend, and cache state.

- 本报告为本地实测结果，非实验室基准测试。
- 数据来自 macOS 活动监视器；README 以 VoicePaste 相关进程组的“内存”列作为主要参考口径。
- “实际内存 / 专用内存 / 共享内存 / VM 被压缩”用于排查和辅助分析，不作为单一产品宣传口径。
- 测试结果可能受系统负载、macOS 内存压缩、是否重启应用、模型切换顺序、CPU/CoreML 后端、缓存状态等因素影响。


| 测试项                                             | 状态  | 推理     | 是否流式     | 内存        | 实际内存      | 专用内存      | 共享内存     | VM 被压缩   |
| ----------------------------------------------- | --- | ------ | -------- | --------- | --------- | --------- | -------- | -------- |
| 初始化                                             | 启动  | -      | -        | 126.0 MB  | 342.7 MB  | 81.5 MB   | 217.4 MB | 0 字节     |
| 空闲                                              | 关闭  | -      | -        | 117.9 MB  | 201.4 MB  | 10.0 MB   | 244.9 MB | 91.5 MB  |
| doubao-streaming - 峰值                           | 开启  | 云      | Y        | 147.8 MB  | 410.8 MB  | 91.9 MB   | 246.9 MB | 0 字节     |
| doubao-streaming - 结束                           | 关闭  | -      | -        | 120.2 MB  | 392.2 MB  | 72.3 MB   | 245.6 MB | 0 字节     |
| sense-voice-int8 - 峰值 - CPU                     | 开启  | CPU    | N        | 557.2 MB  | 1061.5 MB | 489.8 MB  | 256.9 MB | 0 字节     |
| sense-voice-int8 - 峰值 - CPU - 模拟流式              | 开启  | CPU    | Y - 模拟流式 | 580.2 MB  | 1079.5 MB | 506.6 MB  | 229.6 MB | 0 字节     |
| sense-voice-int8 - 峰值 - Core ML                 | 开启  | CoreML | N        | 543.6 MB  | 1026.4 MB | 482.4 MB  | 238.4 MB | 0 字节     |
| sense-voice-int8- 峰值 - Core ML - 模拟流式           | 开启  | CoreML | Y - 模拟流式 | 409.2 MB  | 1185.2 MB | 343.4 MB  | 232.8 MB | 0 字节     |
| sense-voice-int8 - 结束                           | 关闭  | -      | -        | 254.0 MB  | 942.2 MB  | 173.0 MB  | 254.1 MB | 35.2 MB  |
| zipformer-zh-en-int8 - 峰值 - CPU                 | 开启  | CPU    | Y        | 783.4 MB  | 974.6 MB  | 693.0 MB  | 250.5 MB | 18.7 MB  |
| zipformer-zh-en-int8 - 峰值 - Core ML             | 开启  | CoreML | Y        | 462.5 MB  | 873.9 MB  | 401.7 MB  | 231.4 MB | 0 字节     |
| zipformer-zh-en-int8 - 结束                       | 关闭  | -      | -        | 265.0 MB  | 708.3 MB  | 183.6 MB  | 248.4 MB | 18.5 MB  |
| funasr-nano-zh-en-ja-int8 - 峰值 - CPU            | 开启  | CPU    | N        | 2511.1 MB | 2708.4 MB | 2457.6 MB | 239.2 MB | 58.5 MB  |
| funasr-nano-zh-en-ja-int8 - 峰值 - CPU - 模拟流式     | 开启  | CPU    | Y - 模拟流式 | 2349.2 MB | 2726.8 MB | 2255.4 MB | 246.0 MB | 50.4 MB  |
| funasr-nano-zh-en-ja-int8 - 峰值 - Core ML        | 开启  | CoreML | N        | 2165.3 MB | 2564.0 MB | 2061.1 MB | 240.2 MB | 54.2 MB  |
| funasr-nano-zh-en-ja-int8 - 峰值 - Core ML - 模拟流式 | 开启  | CoreML | Y - 模拟流式 | 2243.7 MB | 2161.2 MB | 1589.9 MB | 240.1 MB | 596.1 MB |
| funasr-nano-zh-en-ja-int8 - 结束                  | 关闭  | -      | -        | 416.0 MB  | 936.1 MB  | 327.1 MB  | 239.3 MB | 45.2 MB  |
