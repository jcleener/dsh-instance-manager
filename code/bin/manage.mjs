#!/usr/bin/env node
import { action, logs, status, syncDaemonRuntime } from '../manager.js';
const command = process.argv[2] || 'status';
try {
  let result;
  if (command === 'status') result = await status();
  else if (command === 'sync') result = await syncDaemonRuntime();
  else if (command === 'logs') result = await logs();
  else if (['install','start','stop','uninstall','restart'].includes(command)) result = await action(command);
  else throw new Error('用法：manage.mjs status|logs|install|start|stop|uninstall|restart|sync');
  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
