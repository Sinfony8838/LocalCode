# 事件复盘：Python 命令在命令工具中 100% 挂死至超时（2026-10-28）

一句话：命令执行器的父进程死亡监视线程与 CPython 解释器退出路径在同一 stdin 管道句柄上互锁，导致所有"运行 Python 代码"的命令实际执行完毕后挂死，直到 120 秒外层超时。修复方式是让监视线程改等父进程句柄，并把子进程 stdin 设为关闭。

## 背景

LocalCode 的 `powershell` 工具承担"用户批准的命令随宿主进程生死"的安全承诺，`src/core/command.ts` 里有三层防御：

1. Windows Job 对象（KILL_ON_JOB_CLOSE）：PowerShell 一死，子进程树陪葬；
2. 磁盘 PID 属主记录 + ready 握手：worker 崩溃后主进程可核对并击杀遗留命令（含 PID 复用防误杀）;
3. 父进程死亡 watchdog：原实现为 stdin 管道 EOF 探测——worker 持管道写端，worker 进程消亡则操作系统关闭写端，PowerShell 内注入的 C# 后台线程读 stdin 返回 EOF 即自杀。这层是断电、强杀等彻底崩溃场景的兜底，不依赖任何应用层代码存活。

## 现象

在对 LocalCode agent 做五任务对比评测（同 API 同模型 vs Claude Code）时，T1（修复一个带失败测试的 Python 模块）出现：模型行为完全正确（先读代码、再按提示词要求运行测试），但每条 Python 命令都零输出、约 123 秒后被 120 秒默认超时杀死；`python --version` 却能正常返回。模型反复换姿势重试（裸跑 / `Out-String` / 重定向文件 / `python -c`），全部同样挂死，`stats.py` 始终未被修改。表面上像"agent 卡住了"，实际是基础设施问题，而非模型或 12 次工具预算问题。

## 排查过程

1. **会话与命令日志**（`data/logs/agent-*.jsonl`、`data/logs/commands/*.log`）：模型仅调用 6-8 次工具，排除预算上限；四条命令日志显示精确 ~123 秒间隔 = 120 秒超时 + 开销；`--version` 有输出、跑代码的命令零输出。
2. **外部复现排除法**：同一命令在普通 PowerShell 中 1 秒完成（4 个测试失败正常打印）→ 不是命令本身或 Python 安装问题。
3. **移植复现**：把生产 bootstrap（Job 对象 + ready 握手 + 编码设置 + stdin watchdog）逐字节移植到独立 Node 脚本，复现挂死；随后逐项拆除二分。
4. **二分定位**：完整 bootstrap 挂死；仅去掉 stdin 读线程即恢复正常；仅保留 stdin 读线程（无 Job、无握手、无编码设置）仍挂死 → 唯一致害组件是 watchdog 的 `Console.OpenStandardInput().ReadByte()` 阻塞读。
5. **机理确认**：`python -c "1"`（无输出无输入）也挂；让 Python 写文件的副作用成功发生（代码执行完毕）→ 挂点在解释器退出阶段；给 Python 重定向 `< nul`（不继承该管道句柄）立即恢复；node / cmd / 纯 PowerShell 因退出路径不收拾继承的 stdin 句柄而幸免。

## 根因

设计假设"PowerShell 持有的 stdin 读端对其他进程惰性无害"，但孙子进程会继承同一句柄。CPython 在 `Py_Finalize` 阶段会关闭继承的标准句柄，与 watchdog 线程挂起的阻塞 `ReadFile` 在同一管道对象上互锁：代码早已跑完，进程却永远退不出去，最终被外层超时收割。失败模式极具迷惑性——简单命令（`--version`）有部分输出、无任何报错、表现为"慢"而非"错"。

## 为什么一直没暴露

- 单元测试的子进程全部是 PowerShell 自身或 `cmd.exe`（生命周期、取消、杀树、崩溃清理都测了），恰好都是不触发句柄收拾的形态；没有任何用例通过执行器跑过第三方语言运行时。
- 作者日常使用路径（网页/桌宠生成、Node 工具链）不经过 CPython；node 只是碰巧不踩雷。
- 防御性设计的验证停留在同构子进程上，而 stdin 句柄共享机制的安全边界要求它对任意孙子运行时成立。

## 修复（0.2.3）

`src/core/command.ts`：

- watchdog 改为等待父进程句柄：bootstrap 接收 worker PID，C# 线程 `OpenProcess(SYNCHRONIZE, pid)` + `WaitForSingleObject` 5 秒轮询，父进程终止即 `Environment.Exit(130)`，语义与 stdin EOF 探测完全等价（进程句柄同样由操作系统保证随进程消亡而触发），但不再触碰 stdin。
- spawn 的 stdio 从 `['pipe','pipe','pipe']` 改为 `['ignore','pipe','pipe']`：孙进程继承 NUL 句柄而非管道读端，从机制上杜绝同类共享。
- 新增回归测试：通过执行器跑 `python -c`，断言不超时且输出正确（无可用 Python 时自动跳过）。

验证：`npm run typecheck` 通过；全量 `npm test` 29 个文件 310 用例通过，其中"worker 崩溃时终止命令树"的语义测试确认孤儿命令防护未回退；新回归测试从修复前的必挂 120 秒变为约 3 秒通过。

## 教训

- 跨进程共享操作系统句柄（stdin/stdout/句柄继承）时，安全边界必须按"任意未知孙子进程"评估，不能按自己测试过的子进程形态评估。
- "带外信号通道"（管道 EOF、句柄继承）优雅但隐蔽：出错时表现为子进程行为异常而非本层报错，排查成本高；能用显式机制（等待进程句柄）就不用隐式机制。
- 对执行任意命令的工具，回归测试必须覆盖至少一种"退出路径特殊"的第三方运行时（CPython 是典型：启动即全量初始化 IO、退出即收拾标准句柄）。
