import assert from 'node:assert/strict';
import { apply } from '../code/index.js';
const routes = new Map();
const disposers = [];
const provided = new Map();
const ctx = {
  provide(key, value) { provided.set(key, value); },
  effect(callback) { disposers.push(callback()); },
  inject(names, callback) {
    if (names.length === 1 && names[0] === 'sessionController') return; // no live daemon in registration test
    if (names[0] === 'skills') return callback({ skills: { register(skill) { assert.equal(skill.name, 'restart'); assert.match(skill.content, /subagent_fork/); return () => {}; } } });
    if (names[0] === 'tools') return callback({ approval: {}, tools: { register(tool) { assert.equal(tool.name, 'dsh_restart'); return () => {}; } } });
    assert.deepEqual(names, ['webServer', 'connection']);
    callback({
      webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
      connection: { requestRejection(req) { return req.allowed ? undefined : 401; } },
    });
  },
};
apply(ctx);
assert.ok(provided.has('dshInstanceManager'));
assert.equal(routes.size, 3);
function response() { return { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } }; }
const action = routes.get('/dsh-instance-manager/action');
let res = response();
await action.handler({ method: 'POST', headers: {} }, res);
assert.equal(res.status, 401);
res = response();
await action.handler({ method: 'POST', headers: {}, allowed: true }, res);
assert.equal(res.status, 403);
res = response();
await action.handler({ method: 'GET', headers: {}, allowed: true }, res);
assert.equal(res.status, 405);
for (const d of disposers) d();
assert.equal(routes.size, 0);
console.log('host-routes-auth-disposal-ok');
