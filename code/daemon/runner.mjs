#!/usr/bin/env node
import { startDaemon } from './index.mjs';

// Supervised by the platform launcher (macOS LaunchAgent / Windows scheduled task);
// startup NEVER opens DSH.
try {
  const daemon = await startDaemon();
  const shutdown = () => { daemon.close().then(() => process.exit(0), () => process.exit(1)); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  // "已有实例在跑"是**正常**结果：必须以 0 退出，否则计划任务的 RestartOnFailure
  // 会把正常的重复启动变成每分钟一次的重启风暴。
  if (error?.code === 'ALREADY_RUNNING') {
    console.error('[dsh-instance-manager] daemon already running; exiting 0');
    process.exitCode = 0;
  } else {
    console.error(`[dsh-instance-manager] ${error.stack || error}`);
    process.exitCode = 1;
  }
}
